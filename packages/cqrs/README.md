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
    TypeOrmTransactionalModule.forRoot(),
    CqrsTransactionalModule.forRoot(),
  ],
})
export class AppModule {}
```

> **Do not import `CqrsModule` as well.** This module imports it
> internally and overrides the `EventPublisher` token. A second import
> in your app shadows that override, and aggregate events silently stop
> reaching the dispatcher — no error, just handlers that never fire.

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

`order.commit()` does not dispatch immediately. Each event attaches to
the current transaction at its handler's phase, so the commit decides
what runs.

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

`CqrsTransactionalModule.forRoot()` wraps handlers at bootstrap:

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
CqrsTransactionalModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({ wrapQueryHandlers: cfg.get('WRAP') !== 'false' }),
  // Structural, so it stays outside the factory: it decides whether the
  // EventPublisher override provider exists at all, and NestJS needs
  // provider tokens before any factory has run.
  useTransactionalEventPublisher: true,
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

- **`eventBus.publish(...)` bypasses the dispatcher.** Only events
  emitted by an aggregate through `mergeObjectContext` /
  `mergeClassContext` and `commit()` become phase-aware.
- **Arrow-function class fields are not wrapped.** The wrap point is the
  prototype, and `execute = async (q) => {}` shadows it. Use method
  syntax.
- **`@nestjs/cqrs` 11 or 12 only**, deliberately, while `@nestjs/common`
  and `@nestjs/core` still accept 10. The wrapping mechanism would work on
  `@nestjs/cqrs` 10, but
  `AsyncContext` — which request-scoped handler support depends on —
  does not exist there, and advertising `^10` would promise a documented
  feature that cannot work.

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
