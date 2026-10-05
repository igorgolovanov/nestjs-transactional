# @nestjs-transactional/cqrs

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcqrs?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/cqrs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

Transactions and Spring-style event phases for
[`@nestjs/cqrs`](https://docs.nestjs.com/recipes/cqrs).

It solves the race everyone hits with domain events: an aggregate emits
an event, a handler reacts, and then the transaction rolls back — the
side effect already happened. Here, event handlers declare _when_ they
run relative to the commit, and `AFTER_COMMIT` means the row really is
in the database.

```ts
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent) // AFTER_COMMIT by default
export class NotifyCustomer implements ITransactionalEventHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent) {
    // The order is committed and visible. Safe to send the email.
  }
}
```

Command and query handlers get transactions by decoration, and
`@nestjs/cqrs` is used as-is — not forked, not patched.

Built on
[`@nestjs-transactional/core`](https://www.npmjs.com/package/@nestjs-transactional/core).
Pair with
[`@nestjs-transactional/outbox`](https://www.npmjs.com/package/@nestjs-transactional/outbox)
and `@nestjs/outbox` when a handler must survive a process crash.

## Install

```bash
pnpm add @nestjs-transactional/cqrs @nestjs-transactional/core @nestjs/cqrs
```

## Module format

This package ships **ESM only**, matching NestJS 12, which is ESM-only
across its own packages. There is no CommonJS build.

A CommonJS application still works: Node loads ESM from `require()`
since 22.12.0, which is why `engines.node` is `>=22.13.0`. What does not
follow Node here is tooling with its own module loader — Jest above all,
which needs `NODE_OPTIONS=--experimental-vm-modules` and a few config
settings. The 19 example applications in the repository all run their
suites that way and can be copied from.

Reasoning and measurements: [ADR-022](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/022-esm-only-packaging.md).

## Quick start

```ts
@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TransactionalTypeOrmModule.forRoot(),
    TransactionalCqrsModule.forRoot(),
  ],
})
export class AppModule {}
```

> **Do not import `CqrsModule` as well.** This module imports
> `CqrsModule.forRoot()` itself, with its publisher in the `EventBus`.
> A second import creates a second `EventBus` that bypasses it, so
> bootstrap fails with an error that says so. Pass `CqrsModule` options
> as `forRoot({ cqrs: { ... } })`, and a publisher of your own as
> `forRoot({ eventPublisher })`. `CommandBus`, `QueryBus` and `EventBus`
> are injectable anywhere.

Then a command handler, transactional by decoration:

```ts
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand> {
  constructor(
    private readonly publisher: EventPublisher,
    private readonly orders: OrderRepository,
  ) {}

  @Transactional()
  async execute(command: PlaceOrderCommand) {
    const order = this.publisher.mergeObjectContext(new Order(command.orderId));
    order.place();
    await this.orders.save(order);
    order.commit(); // events become hooks on this transaction
  }
}
```

`order.commit()` publishes through the `@nestjs/cqrs` `EventBus`.
Each `@TransactionalEventsHandler` attaches to the current transaction
at its phase, so the commit decides what runs. A plain `@EventsHandler`
and sagas run at once, inside the transaction, as `@nestjs/cqrs` always
runs them. A direct `eventBus.publish(event)` takes the same route.

Inside a transaction, the bus also hands its publisher chain
`{ transaction }` as the dispatcher context, the convention
`@nestjs/cqrs` 12.1 documents for `commit(context)`. That is what lets
`@nestjs/workflows`' `WorkflowsCqrsModule` start and signal workflows in
the business transaction: `@StartOn(OrderPlaced)` commits or rolls back
with the order, and nobody passes the transaction by hand
([ADR-024](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/024-cqrs-events-through-the-event-bus.md)).

## Event phases

| Phase                      | Fires                                  | If the handler throws      |
| -------------------------- | -------------------------------------- | -------------------------- |
| `BEFORE_COMMIT`            | before COMMIT is issued                | the transaction rolls back |
| `AFTER_COMMIT` _(default)_ | after COMMIT succeeds                  | logged and swallowed       |
| `AFTER_ROLLBACK`           | after ROLLBACK, with the causing error | logged and swallowed       |
| `AFTER_COMPLETION`         | on either outcome                      | logged and swallowed       |

```ts
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  phase: TransactionPhase.AFTER_ROLLBACK,
})
```

Two flags worth knowing: `fallbackExecution: true` makes a handler fire
even when the event is published outside any transaction (otherwise such
events are dropped with a warning), and `async: true` fires it through
`queueMicrotask` so its errors can never reach the rollback path.

## What gets wrapped

`TransactionalCqrsModule.forRoot()` wraps handlers at bootstrap:

- **Command handlers** carrying `@Transactional()` (method- or
  class-level). Set `defaultCommandOptions` to wrap them all.
- **Query handlers** — wrapped read-only by default
  (`defaultQueryOptions: { readOnly: true }`). Pass `undefined` to opt
  out. Note that `readOnly` is enforced by the database only on
  Postgres-family dialects.
- **Event handlers** only when they carry `@Transactional()`. There is
  no kind-level default, because event handlers are often out-of-band
  side effects where a transaction is the wrong thing.

Async configuration works the same way, with one wrinkle:

```ts
TransactionalCqrsModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({ wrapQueryHandlers: cfg.get('WRAP') !== 'false' }),
  // Structural, so they stay outside the factory: they shape the
  // CqrsModule import, which NestJS needs before any factory has run.
  cqrs: { rethrowUnhandled: true },
});
```

## Choosing a handler decorator

|                                         | Persisted | Retried | Survives restart |
| --------------------------------------- | --------- | ------- | ---------------- |
| `@TransactionalEventsHandler`           | no        | no      | no               |
| `@IntegrationEventsHandler`             | no        | no      | no               |
| `@OnOutboxMessage` _(`@nestjs/outbox`)_ | yes       | yes     | yes              |

Use `@TransactionalEventsHandler` for in-process work that is fine to
lose on a crash, such as cache invalidation and metrics, and when you
need a phase other than after-commit.

`@IntegrationEventsHandler` is the opinionated form for cross-module
code: after the commit, asynchronously, in a transaction of its own. It
mirrors Spring Modulith's `@ApplicationModuleListener`. Delivery is
still in-memory, so a crash between the commit and the handler loses
the call.

When the work must survive that (external API calls, emails, billing),
publish the event through
[`@nestjs-transactional/outbox`](https://www.npmjs.com/package/@nestjs-transactional/outbox)
and handle it with `@nestjs/outbox`'s `@OnOutboxMessage`, which retries,
deduplicates and dead-letters. With `TransactionalOutboxModule`
imported, events an aggregate commits reach the outbox too: the
`@Externalized` ones are added just before the transaction commits, so a
rollback leaves neither the in-memory handlers fired nor a message
written.

Until 2.x, `@IntegrationEventsHandler` became durable by itself once the
outbox was wired, and took an `id` option for its stored listener. From
3.0.0, durable delivery belongs to `@nestjs/outbox`, and the option is
gone
([ADR-023](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/023-delegate-delivery-to-nestjs-outbox.md)).

## Limitations

- **The dispatcher context names one DataSource.** `{ transaction }` is
  the transaction on `eventsDataSource`, `'default'` unless configured.
- **Arrow-function class fields are not wrapped.** The wrap point is the
  prototype, and `execute = async (q) => {}` shadows it. Use method
  syntax.
- **`@nestjs/cqrs` 11 or 12, with NestJS 11 or 12.** CI runs both ends:
  NestJS 12 with `@nestjs/cqrs` 12.1, and NestJS 11 with 11.0.3.

Handlers of any scope are supported, including `Scope.REQUEST` and
`Scope.TRANSIENT`, because the wrap is applied to the prototype
([ADR-020](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/020-prototype-level-cqrs-wrapping.md)).

## Documentation

- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)
- [Transactional events and Spring semantics (ADR-002)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/002-transactional-events-spring-semantics.md)
- [Handler API design (ADR-014)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/014-handler-api-redesign.md)
- [Why `@nestjs/cqrs` is not forked (DD-002)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/002-no-fork-nestjs-cqrs.md)
- Runnable examples:
  [`basic-cqrs`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/basic-cqrs),
  [`multi-datasource-cqrs`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/multi-datasource-cqrs),
  [`saga-pattern`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/saga-pattern),
  [`e-commerce-orders`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/e-commerce-orders)

## License

MIT
