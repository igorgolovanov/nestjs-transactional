# @nestjs-transactional/cqrs

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcqrs/alpha?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/cqrs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

Transactions and Spring-style event phases for
[`@nestjs/cqrs`](https://docs.nestjs.com/recipes/cqrs).

It solves the race everyone hits with domain events: an aggregate emits
an event, a handler reacts, and then the transaction rolls back — the
side effect already happened. Here, event handlers declare *when* they
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
when a handler must survive a process crash.

> **Alpha.** The public API is stable in intent but may still change
> before `1.0.0`.

## Install

```bash
pnpm add @nestjs-transactional/cqrs @nestjs-transactional/core @nestjs/cqrs
```

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

| Phase | Fires | If the handler throws |
| --- | --- | --- |
| `BEFORE_COMMIT` | before COMMIT is issued | the transaction rolls back |
| `AFTER_COMMIT` *(default)* | after COMMIT succeeds | logged and swallowed |
| `AFTER_ROLLBACK` | after ROLLBACK, with the causing error | logged and swallowed |
| `AFTER_COMPLETION` | on either outcome | logged and swallowed |

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

| | Persisted | Retried | Survives restart |
| --- | --- | --- | --- |
| `@TransactionalEventsHandler` | no | no | no |
| `@OutboxEventsHandler` *(outbox package)* | yes | yes | yes |
| `@IntegrationEventsHandler` | if the outbox is wired | if wired | if wired |

Use `@TransactionalEventsHandler` for in-process work that is fine to
lose on a crash — cache invalidation, metrics. Use
`@OutboxEventsHandler` when at-least-once delivery matters: external
API calls, emails, billing.

`@IntegrationEventsHandler` is the one to reach for by default in
cross-module code. It routes through the outbox when
`OUTBOX_LISTENER_REGISTRAR` is bound and falls back to in-memory
delivery when it is not — decided at bootstrap by module wiring, not at
the call site. The same handler therefore runs in-memory during early
development and durably once a worker exists, without touching the
handler. It mirrors Spring Modulith's `@ApplicationModuleListener`.

To turn on durable delivery, bind both structural ports:

```ts
providers: [
  { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
  { provide: OUTBOX_LISTENER_REGISTRAR, useExisting: OutboxListenerRegistry },
];
```

A rollback then undoes all of it: no in-memory handler fires, no
publication row persists, nothing downstream runs.

Listener ids are `${baseId}#${EventName}`, with `baseId` defaulting to
the class name — so pass an explicit `id` if the class may be renamed,
or stored publications will be orphaned.

## Limitations

- **`eventBus.publish(...)` bypasses the dispatcher.** Only events
  emitted by an aggregate through `mergeObjectContext` /
  `mergeClassContext` and `commit()` become phase-aware.
- **Arrow-function class fields are not wrapped.** The wrap point is the
  prototype, and `execute = async (q) => {}` shadows it. Use method
  syntax.
- **`@nestjs/cqrs@11` only**, deliberately, while the other peers accept
  `^10 || ^11`. The wrapping mechanism would work on v10, but
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
