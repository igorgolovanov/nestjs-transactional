# @nestjs-transactional

[![CI](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml/badge.svg)](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node: 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)
[![TypeScript: 5.5+](https://img.shields.io/badge/typescript-5.5+-blue)](https://www.typescriptlang.org/)

**Declarative transactions for NestJS.** One decorator, and
everything underneath it commits or rolls back together — including the
repositories you already inject and the events you already publish.

NestJS's own reliability modules, [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox)
and [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows),
write in your transaction when you hand it to them. `@Transactional` is
what hands it over, so the outbox message and the workflow instance
commit with your rows without a transaction parameter anywhere in your
code.

## The thing this fixes

Every NestJS codebase that touches a database eventually grows this:

```ts
async placeOrder(dto: PlaceOrderDto) {
  return this.dataSource.transaction(async (em) => {
    const order = await em.getRepository(Order).save(dto);
    await this.stock.reserve(order, em); //   pass the em down…
    await this.payments.charge(order, em); // …through every layer…
    await this.audit.record(order, em); //   …and never forget one
    return order;
  });
}
```

The `EntityManager` becomes a parameter on half your service methods.
Miss it once and that call quietly runs outside the transaction —
committing on its own, surviving a rollback that should have erased it.

Here that is one decorator:

```ts
@Transactional()
async placeOrder(dto: PlaceOrderDto) {
  const order = await this.orders.save(dto); // your @InjectRepository
  await this.stock.reserve(order);
  await this.payments.charge(order);
  await this.audit.record(order);
  return order;
}
```

Nothing was rewritten to make that work. The repositories are the same
`@InjectRepository(Order)` instances, the services take no new
arguments, and outside a `@Transactional` method they autocommit exactly
as before. The transaction travels through `AsyncLocalStorage`, so it
survives every `await` on the way down.

## Then it gets interesting

**Events that mean what they say.** An `AFTER_COMMIT` handler runs after
the database has actually committed — never before, never on a rollback:

```ts
@TransactionalEventsHandler(OrderPlacedEvent) // AFTER_COMMIT by default
export class NotifyCustomer implements ITransactionalEventHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent) {
    await this.mail.send(event); // the order is really there
  }
}
```

That single guarantee removes the oldest bug in event-driven services:
the email that went out for an order the rollback erased.

**Delivery that survives the process dying.** Publish through the
outbox and the event is written to the database *in the same
transaction* as the order, with no transaction passed by hand. The
first-party [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox)
then delivers it: it retries with backoff, recovers after a crash on any
instance, deduplicates per handler, and can push to Kafka or RabbitMQ:

```ts
@Transactional()
async placeOrder(dto: PlaceOrderDto) {
  const order = await this.orders.save(dto);
  await this.publisher.publish(new OrderPlacedEvent(order.id)); // commits with the order
  return order;
}
```

Either the order and the intent to notify both land, or neither does.
`@nestjs/outbox` on its own asks you to pass the transaction to
`outbox.add(tx, ...)` through every layer; `@Transactional` is what
removes that parameter.

**Workflows that start with the order.** The same goes for
[`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows):
a durable workflow started inside the transaction exists if and only if
the order does, and so does one that `@StartOn` starts from an event
the aggregate publishes:

```ts
@Transactional()
async placeOrder(dto: PlaceOrderDto) {
  const order = await this.orders.save(dto);
  await this.workflows.start(FulfilOrder, order, { id: `order-${order.id}` }); // no { transaction }
  return order;
}
```

**Retries the database asks for.** Under `SERIALIZABLE`, PostgreSQL
fails one of two conflicting transactions and expects you to run it
again. `@Transactional({ isolation: 'SERIALIZABLE', retry: 3 })` does,
from the frame that owns the transaction, with fresh hooks on every
attempt.

**All seven propagation modes**, not the two that are easy.
`REQUIRES_NEW` gives you the audit row that survives the caller's
rollback. `NESTED` gives you a savepoint — and on a driver without
savepoint support it raises a clear error instead of silently running
your "nested" transaction as part of the outer one.

**Multiple dataSources as a first-class case**, not a footnote:
`@Transactional({ dataSource: 'billing' })` routes to the right adapter,
and a repository bound to another one falls back to its own manager
rather than silently joining.

## Next to the NestJS reliability modules

NestJS ships its reliability tooling as separate modules. None of them
has an ambient transaction; the ones that write to your database take it
explicitly. This is how each one meets `@Transactional`:

| Module | What this repository adds |
| --- | --- |
| [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox) | [`outbox`](packages/outbox): publish inside the transaction, `@Externalized` routing to brokers |
| [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows) | [`workflows`](packages/workflows): `start()`, `signal()`, `@StartOn` and `@SignalOn` inside the transaction |
| [`@nestjs/cqrs`](https://docs.nestjs.com/recipes/cqrs) | [`cqrs`](packages/cqrs): handlers in a transaction, phase-aware event handlers, `{ transaction }` in the event bus's dispatcher context |
| [`@nestjs/resilience`](https://docs.nestjs.com/reliability/resilience) | `@Transactional({ retry })` for the retries only the transaction's owner can do; guidance on where `@Retry` belongs |
| [`@nestjs/locks`](https://docs.nestjs.com/reliability/locks), [`@nestjs/idempotency`](https://docs.nestjs.com/reliability/idempotency) | nothing to bridge: both keep their state outside your transaction by design. The [guide](docs/guides/reliability-modules.md) covers the ordering that keeps them correct |

## Install

```bash
pnpm add @nestjs-transactional/core @nestjs-transactional/typeorm
```

```ts
@Module({
  imports: [
    TypeOrmModule.forRoot({
      /* your existing config */
    }),

    TransactionalModule.forRoot({ isGlobal: true }),
    TransactionalTypeOrmModule.forRoot(),
  ],
})
export class AppModule {}
```

That is the entire setup for the first half of this page. Add
`@nestjs-transactional/cqrs` for the event phases,
`@nestjs-transactional/outbox` with `@nestjs/outbox` for durable delivery
and brokers, `@nestjs-transactional/workflows` with `@nestjs/workflows`
for durable workflows. Each is additive, and none of them changes code
you have already written.

**These packages are ESM only**, from `2.0.0`, matching NestJS 12. A
CommonJS application still consumes them: Node loads ESM from
`require()` as of 22.12.0, which is what the `>=22.13.0` floor covers.
What does not follow Node is tooling with its own module loader — Jest
needs `--experimental-vm-modules` and a few settings, shown in all 14
example applications. The reasoning, and why one build rather than two,
is in [ADR-022](docs/adr/022-esm-only-packaging.md).

## Packages

| Package | npm | What it adds |
| --- | --- | --- |
| [`core`](packages/core) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcore?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/core) | `@Transactional`, the propagation modes, the adapter SPI. ORM-agnostic |
| [`typeorm`](packages/typeorm) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Ftypeorm?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/typeorm) | The TypeORM adapter and transparent transactional repositories |
| [`cqrs`](packages/cqrs) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcqrs?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/cqrs) | Transactions for `@nestjs/cqrs` handlers, phase-aware event handlers, `AggregateRoot` integration |
| [`outbox`](packages/outbox) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox) | `@Transactional` for [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox): publish inside the transaction, `@Externalized` routing to brokers |
| [`workflows`](packages/workflows) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Fworkflows?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/workflows) | `@Transactional` for [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows): durable workflows started and signalled inside the transaction, `@StartOn` included |

## Where the sharp edges are

A library that only lists its strengths is telling you half the story.
These are documented, tested, and worth knowing before you adopt:

- **`readOnly` is enforced on Postgres-family dialects only.** There the
  adapter issues `SET TRANSACTION READ ONLY` and the database refuses
  the write. On MySQL it cannot be done at all — `SET TRANSACTION`
  applies to the *next* transaction there. Develop on SQLite, deploy on
  Postgres, and you meet the constraint for the first time in
  production. ([DD-027](docs/dd/027-readonly-and-timeout-semantics.md))
- **`timeout` is deprecated, and was never implemented.** Deliberately
  not approximated: Postgres' `statement_timeout` bounds each statement,
  not the transaction, so it would mean something quietly different from
  what it says. It goes in the next major.
  ([DD-032](docs/dd/032-transaction-retry-and-timeout.md))
- **Broker acknowledgement depends on the transport.** Kafka and
  RabbitMQ wait for a real acknowledgement, so a broker that is down
  keeps the message in the outbox and the relay retries it. NATS core
  and TCP acknowledge nothing, and gRPC cannot be used at all.
  Per-transport table and measurements:
  ([ADR-021](docs/adr/021-externalization-acknowledgement-per-transport.md))
- **The outbox lives in one DataSource.** `@nestjs/outbox` takes one
  store per application, so publishing from a transaction on another
  DataSource throws rather than writing outside it.
  ([ADR-023](docs/adr/023-delegate-delivery-to-nestjs-outbox.md))
- **`@nestjs/outbox` and `@nestjs/workflows` are pre-1.0.** The bridges
  pin `~0.1.0` and `~0.0.1` and widen only after each release passes
  their integration suites.
- **A workflow signal needs READ COMMITTED on PostgreSQL.** Inside a
  `SERIALIZABLE` or `REPEATABLE_READ` transaction it fails before
  anything is written, rather than risk missing a wake-up.
  ([DD-031](docs/dd/031-workflows-bridge-contract.md))
- **No distributed transactions across dataSources.** That is a design
  decision, not a gap — cross-dataSource atomicity goes through the
  outbox.
- **Two escape hatches** where the transparent-repository patch does not
  reach: `em.save(Entity, …)` called directly on an injected
  `EntityManager`, and `BaseEntity` statics.
  ([known-limitations.md](docs/known-limitations.md))

If you only want transparent repositories and nothing else,
[`typeorm-transactional`](https://www.npmjs.com/package/typeorm-transactional)
does that one job well and is a smaller dependency. Reach for this when
you also want propagation modes, multi-dataSource routing, phase-aware
events, or durable delivery.

## How it is verified

The interesting guarantees are the ones a test can fail on:

- Transactions, savepoints and isolation run against **real Postgres**
  through testcontainers — not a mock, not SQLite standing in.
- The matrix covers **three TypeORM versions** (`0.3.31`, `1.0.0`,
  `1.1.0`) across **Node 22, 24 and 26**, so the declared peer range is
  a tested claim rather than an optimistic one.
- All **14 example applications** are built and run in CI, so a library
  change that breaks the documented usage fails the build.
- The **public API surface is committed** as api-extractor reports; any
  change to it shows up as a reviewable diff.
- **`publint` and `@arethetypeswrong/cli`** check the packed tarball, so
  what you resolve from npm matches what the sources declare.

## Examples

Fourteen runnable applications under [`examples/`](examples/), in five
tiers from a single decorator to an e-commerce service with three
bounded contexts, CQRS, a saga over the outbox and Kafka:

```bash
pnpm -C examples/basic-transactional start
```

Start with [`basic-transactional`](examples/basic-transactional) for
transactions, [`basic-typeorm-outbox`](examples/basic-typeorm-outbox) for durability, or
[`e-commerce-orders`](examples/e-commerce-orders) to see everything at
once. The [catalogue](examples/README.md) has a decision guide for
picking a starting point.

## Documentation

- **Per-package guides** — [core](packages/core/README.md),
  [typeorm](packages/typeorm/README.md), [cqrs](packages/cqrs/README.md),
  [outbox](packages/outbox/README.md), [workflows](packages/workflows/README.md)
- **Architecture** — [core design](docs/architecture/core-design.md),
  [the outbox pattern](docs/architecture/outbox-pattern.md),
  [outbox × CQRS](docs/architecture/outbox-integration-with-cqrs.md),
  [event externalization](docs/architecture/event-externalization.md),
  [scope and coverage](docs/architecture/scope-and-coverage.md)
- **With the NestJS reliability modules**: [outbox, workflows, cqrs, resilience, locks, idempotency](docs/guides/reliability-modules.md)
- **Migrating** — [from 2.x to 3.0](docs/guides/migrating-to-3.md),
  [from in-memory handlers to the outbox](docs/guides/migrating-to-outbox.md)
- **Why things are the way they are** — [ADRs](docs/adr/) and
  [design decisions](docs/dd/). Every non-obvious trade-off in this
  library has a written record, including the ones that turned out to be
  mistakes.

## Status

`2.0.0`, ESM only. The public API is under a
[stability policy](docs/adr/004-public-api-stability.md): breaking
changes cost a major version and an ADR explaining why.

Outbox delivery moves to `@nestjs/outbox` in 3.0.0
([ADR-023](docs/adr/023-delegate-delivery-to-nestjs-outbox.md)): storage,
retries, dead letters, ordering, inboxes and observability are
maintained there, and this repository keeps the transactional
programming model on top. Nothing else is scheduled. The
[improvement plan](docs/roadmap/improvement-plan.md) records the earlier
work.

## Contributing

Bug reports are welcome, and so is disagreement with a decision record.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the dev setup, the testing
strategy and the commit conventions.

## License

MIT — see [LICENSE](LICENSE).
