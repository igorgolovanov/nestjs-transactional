# `@Transactional` with the NestJS reliability modules

NestJS publishes its reliability tooling as separate modules under
[docs.nestjs.com/reliability](https://docs.nestjs.com/reliability/outbox).
None of them keeps a transaction on the async context. The ones that
write to your database take the transaction as an argument, and the
others keep their state outside it on purpose. This guide covers each
module in turn: what to wire, and in which order things must happen for
the guarantees to hold.

## The outbox and workflows: bridged

[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox) and
[`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows)
write an outbox message, a workflow instance or a signal in your
transaction when they are handed it: `outbox.add(tx, ...)`,
`start(..., { transaction })`. The bridges hand it to them from
`@Transactional`:

- [`@nestjs-transactional/outbox`](../../packages/outbox/README.md):
  `OutboxEventPublisher.publish()` inside a transaction
  ([DD-028](../dd/028-outbox-bridge-contract.md));
- [`@nestjs-transactional/workflows`](../../packages/workflows/README.md):
  `WorkflowClient.start()` and `signal()`, and with them `@StartOn` and
  `@SignalOn` ([DD-031](../dd/031-workflows-bridge-contract.md)).

Both join one DataSource, the one their store runs on.

The ORM under them does not matter to the bridges. They take the
transaction from the adapter, so they work the same on TypeORM and on
Drizzle ORM ([`@nestjs-transactional/drizzle`](../../packages/drizzle/README.md)):
give the stores `fromTypeOrm(dataSource)` or `fromDrizzle(db)` from
`@nestjs/outbox/postgres` and `@nestjs/workflows/postgres`. The
[`drizzle-orders`](../../examples/drizzle-orders) example wires all of
it on Drizzle.

## CQRS: through the event bus

`@nestjs-transactional/cqrs` puts its publisher in `@nestjs/cqrs`'s
`EventBus` ([ADR-024](../adr/024-cqrs-events-through-the-event-bus.md)).
Every event published inside `@Transactional`, from an aggregate's
`commit()` or from `eventBus.publish()`:
- schedules the `@TransactionalEventsHandler`s for their phase;
- reaches `@EventsHandler`s and sagas at once, inside the transaction;
- carries `{ transaction }` in its dispatcher context, which is how
  `WorkflowsCqrsModule` writes in the transaction.

Import `CqrsModule` only through `TransactionalCqrsModule.forRoot({ cqrs })`.

## Resilience: retry the transaction, not inside it

[`@nestjs/resilience`](https://docs.nestjs.com/reliability/resilience)
retries, times out, breaks circuits and limits concurrency.

- **`@Retry` on a controller wraps the whole request**, and so the
  `@Transactional` service method it calls. Each attempt gets a new
  transaction. That is the right order, provided the controller method
  is not itself `@Transactional`.
- **A policy inside a `@Transactional` method is wrong for database
  errors.** `policy.execute(() => this.repo.save(...))` inside a
  transaction retries a statement in a transaction that the first
  failure has already aborted: on PostgreSQL, every later statement
  fails until the rollback. Retry around the transaction instead.
- **Serialization failures and deadlocks** are retried by the
  transaction's owner: `@Transactional({ isolation: 'SERIALIZABLE',
  retry: 3 })` ([DD-032](../dd/032-transaction-retry-and-timeout.md)).
  Resilience's `@Retry` has no notion of SQLSTATE 40001.
- **`@Timeout` does not cancel a query.** Its `AbortSignal` reaches the
  method, not the database driver, so an attempt that timed out can
  still commit later. With `@Retry` around it, that is a second write.
  Bound slow statements in the database, for instance with
  `statement_timeout`.

## Locks: acquire, begin, commit, release

[`@nestjs/locks`](https://docs.nestjs.com/reliability/locks) leases a
key across instances, with a fencing token. Its store runs on its own
connection, never in your transaction, which is the point.

- **Order.** Acquire the lock, then begin the transaction, commit, and
  only then release. A lock released before the commit lets the next
  holder read the state the commit has not written yet:

  ```ts
  async rebuildStock(sku: string) {
    await this.locks.withLock(`stock:${sku}`, () => this.stock.rebuild(sku)); // rebuild() is @Transactional
  }
  ```

  `@WithoutOverlapping` and `@OnOneInstance` on the outer method give
  the same order, as long as the `@Transactional` method is a different
  one that it calls.
- **Fencing.** A lease can expire while its holder still runs. Check the
  fencing token in the write itself, inside the transaction:
  `UPDATE ... WHERE id = $1 AND fencing_token <= $2`.

## Idempotency: the record lives outside the transaction

[`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency)
stores the response of a request under its idempotency key. By design
its record is never part of your business transaction: its interceptor
writes it after the handler returns, which is after `@Transactional`
has committed.

- **The window.** If the process dies between your commit and the
  record, a retried request runs again. Make the business write
  idempotent on its own, with a unique key on the request's identity,
  so the second run finds the row and returns it.
- **Side effects.** A payment that succeeded at the provider, followed by
  a failed commit, releases the key, and the retry charges again. Pass
  the idempotency key on to the provider, or put the call behind the
  outbox, so it happens once after the commit.

## See also

- [Outbox pattern](../architecture/outbox-pattern.md)
- [Outbox × CQRS](../architecture/outbox-integration-with-cqrs.md)
- [Scope and coverage](../architecture/scope-and-coverage.md)
