# @nestjs-transactional

[![CI](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml/badge.svg)](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node: 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](https://nodejs.org)
[![TypeScript: 5.5+](https://img.shields.io/badge/typescript-5.5+-blue)](https://www.typescriptlang.org/)

**Spring's transaction model, for NestJS.** One decorator, and
everything underneath it commits or rolls back together — including the
repositories you already inject and the events you already publish.

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

**Delivery that survives the process dying.** Switch one decorator and
the same handler is backed by a transactional outbox — the handler's
invocation is written to the database *in the same transaction* as the
order, then delivered by a worker that retries, recovers after a
restart, and can push to Kafka or RabbitMQ:

```ts
@IntegrationEventsHandler(OrderPlacedEvent) // durable when the outbox is wired
```

Either the order and the intent to notify both land, or neither does.
This is Spring Modulith's Event Publication Registry, and the mapping is
one-to-one — including the operator APIs, the completion modes and the
staleness monitor.

**All seven propagation modes**, not the two that are easy.
`REQUIRES_NEW` gives you the audit row that survives the caller's
rollback. `NESTED` gives you a savepoint — and on a driver without
savepoint support it raises a clear error instead of silently running
your "nested" transaction as part of the outer one.

**Multiple dataSources as a first-class case**, not a footnote:
`@Transactional({ dataSource: 'billing' })` routes to the right adapter,
and a repository bound to another one falls back to its own manager
rather than silently joining.

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
    TypeOrmTransactionalModule.forRoot(),
  ],
})
export class AppModule {}
```

That is the entire setup for the first half of this page. Add
`@nestjs-transactional/cqrs` for the event phases,
`@nestjs-transactional/outbox` plus `outbox-typeorm` for durability, and
`outbox-microservices` to reach a broker — each is additive, and none of
them changes code you have already written.

## Packages

| Package | npm | What it adds |
| --- | --- | --- |
| [`core`](packages/core) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcore?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/core) | `@Transactional`, the propagation modes, the adapter SPI. ORM-agnostic |
| [`typeorm`](packages/typeorm) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Ftypeorm?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/typeorm) | The TypeORM adapter and transparent transactional repositories |
| [`cqrs`](packages/cqrs) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcqrs?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/cqrs) | Transactions for `@nestjs/cqrs` handlers, phase-aware event handlers, `AggregateRoot` integration |
| [`outbox`](packages/outbox) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox) | The Event Publication Registry: worker, retry, recovery, operator APIs |
| [`outbox-typeorm`](packages/outbox-typeorm) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox-typeorm?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox-typeorm) | Storage for the outbox — the `event_publication` tables, a repository, and a migration |
| [`outbox-microservices`](packages/outbox-microservices) | [![npm](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox-microservices?label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox-microservices) | Forwarding events to Kafka, RabbitMQ, NATS, Redis, gRPC via `ClientProxy` |

## Where the sharp edges are

A library that only lists its strengths is telling you half the story.
These are documented, tested, and worth knowing before you adopt:

- **`readOnly` is enforced on Postgres-family dialects only.** There the
  adapter issues `SET TRANSACTION READ ONLY` and the database refuses
  the write. On MySQL it cannot be done at all — `SET TRANSACTION`
  applies to the *next* transaction there. Develop on SQLite, deploy on
  Postgres, and you meet the constraint for the first time in
  production. ([DD-027](docs/dd/027-readonly-and-timeout-semantics.md))
- **`timeout` is accepted and not implemented.** Deliberately not
  approximated: Postgres' `statement_timeout` bounds each statement, not
  the transaction, so it would mean something quietly different from
  what it says.
- **Broker delivery is fire-and-forget.** `ClientProxy.emit()` cannot
  report that a broker rejected a message, so a publication can be
  marked complete when nothing arrived. Native broker-aware
  externalizers are the fix and are not written yet.
  ([ADR-016](docs/adr/016-externalization-reliability-semantics.md))
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
- All **19 example applications** are built and run in CI, so a library
  change that breaks the documented usage fails the build.
- The **public API surface is committed** as api-extractor reports; any
  change to it shows up as a reviewable diff.
- **`publint` and `@arethetypeswrong/cli`** check the packed tarball, so
  what you resolve from npm matches what the sources declare.

## Examples

Nineteen runnable applications under [`examples/`](examples/), in five
tiers from a single decorator to a three-dataSource e-commerce service
with CQRS, an outbox per dataSource and Kafka externalization:

```bash
pnpm -C examples/basic-transactional start
```

Start with [`basic-transactional`](examples/basic-transactional) for
transactions, [`basic-outbox`](examples/basic-outbox) for durability, or
[`e-commerce-orders`](examples/e-commerce-orders) to see everything at
once. The [catalogue](examples/README.md) has a decision guide for
picking a starting point.

## Documentation

- **Per-package guides** — [core](packages/core/README.md),
  [typeorm](packages/typeorm/README.md), [cqrs](packages/cqrs/README.md),
  [outbox](packages/outbox/README.md),
  [outbox-typeorm](packages/outbox-typeorm/README.md),
  [outbox-microservices](packages/outbox-microservices/README.md)
- **Architecture** — [core design](docs/architecture/core-design.md),
  [the outbox pattern](docs/architecture/outbox-pattern.md),
  [outbox × CQRS](docs/architecture/outbox-integration-with-cqrs.md),
  [event externalization](docs/architecture/event-externalization.md),
  [Spring Modulith parity](docs/architecture/spring-modulith-parity.md)
- **Migrating** — [from in-memory handlers to the outbox](docs/guides/migrating-to-outbox.md)
- **Why things are the way they are** — [ADRs](docs/adr/) and
  [design decisions](docs/dd/). Every non-obvious trade-off in this
  library has a written record, including the ones that turned out to be
  mistakes.

## Status

`1.0.0`. The public API is under a
[stability policy](docs/adr/004-public-api-stability.md): breaking
changes cost a major version and an ADR explaining why.

Next up: observability hooks for the outbox worker, a scheduled cleanup
job for completed publications, and broker-aware externalizers that
close the delivery gap above. Prisma and MongoDB storage backends are
unblocked by the adapter contract but unscheduled — the
[improvement plan](docs/roadmap/improvement-plan.md) tracks all of it.

## Contributing

Bug reports are welcome, and so is disagreement with a decision record.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the dev setup, the testing
strategy and the commit conventions.

## License

MIT — see [LICENSE](LICENSE).
