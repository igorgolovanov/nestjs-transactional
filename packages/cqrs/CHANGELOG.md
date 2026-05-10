# @nestjs-transactional/cqrs

## 1.0.0-alpha.0

### Minor Changes

- [`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  `@nestjs/cqrs` integration without forking it (ADR-003):
  - `@TransactionalEventsHandler` — class-level event handler decorator
    with Spring-compatible phases (`BEFORE_COMMIT`, `AFTER_COMMIT`
    default, `AFTER_ROLLBACK`, `AFTER_COMPLETION`). Implements
    `ITransactionalEventHandler<T>` with a single `handle(event)` method.
    Matches `@nestjs/cqrs`'s own `@EventsHandler` ergonomics (ADR-014).
  - `@IntegrationEventsHandler` — class-level smart default for
    cross-module handlers. Delivers via the outbox when the
    `OUTBOX_LISTENER_REGISTRAR` structural port is bound (durable,
    retried, resumable); falls back to in-memory `AFTER_COMMIT` +
    `async: true` dispatch otherwise. Spring Modulith
    `@ApplicationModuleListener` parity.
  - `TransactionalEventPublisher` + adapter — drop-in replacement for
    `@nestjs/cqrs`'s `EventPublisher`. `AggregateRoot.commit()` events
    attach as phase hooks on the active transaction; no more "event
    published, transaction rolled back" race.
  - `HybridEventPublisher` — strategy wired by
    `CqrsTransactionalModule.forRoot()`. Routes `aggregate.commit()`
    through the in-memory dispatcher AND, when an outbox scheduler is
    bound to `OUTBOX_PUBLICATION_SCHEDULER`, also through
    `@nestjs-transactional/outbox` for durable delivery.
  - `CqrsHandlerWrapper` + `CqrsTransactionalBootstrap` — bootstrap-time
    wrapping of every `@CommandHandler` / `@QueryHandler` /
    `@EventsHandler` carrying `@Transactional()` metadata.
  - Multi-DataSource support (Phase 14.3.1 Category B) —
    `@TransactionalEventsHandler({ events, dataSource })` pins handlers
    to a specific dataSource's transaction context.
  - `CqrsTransactionalModule.forRoot({...})` single entry point.

  Peer deps: `@nestjs-transactional/core`, `@nestjs/cqrs ^11.0.0`.
  Public alpha.

### Patch Changes

- Updated dependencies [[`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
