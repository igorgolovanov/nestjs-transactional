# @nestjs-transactional/cqrs

## 1.0.0-alpha.3

### Patch Changes

- [#8](https://github.com/igorgolovanov/nestjs-transactional/pull/8) [`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Pin npm dist-tag to `alpha` while in the pre-release cohort.

  Each package's `publishConfig` now declares `"tag": "alpha"`, so
  `npm publish` (driven by `changesets/action` from the Release
  workflow) places every pre-release into the `alpha` dist-tag instead
  of `latest`. Previously the `release` script (`changeset publish`)
  did not pass `--tag`, and changesets does not infer the pre-release
  tag automatically — so the second and every subsequent
  pre-release publish wrote the new version into `latest`, leaving
  the `alpha` tag pointing at `1.0.0-alpha.0` while `latest` advanced
  to the freshest pre-release. That was already the case on
  `@nestjs-transactional/typeorm` and `@nestjs-transactional/outbox-typeorm`
  after the TypeORM 1.0 bump (`1.0.0-alpha.0` → `1.0.0-alpha.1`) and on
  `@nestjs-transactional/cqrs` after ADR-020 (`1.0.0-alpha.0` →
  `1.0.0-alpha.2`); manual `npm dist-tag` runs corrected the registry.

  `publishConfig.tag` is declarative per-package and survives
  `changesets/action` updates without changes to the release workflow
  or root scripts. The setting will be removed (or flipped to `latest`)
  as part of the `pnpm changeset pre exit` step before promoting the
  cohort to stable `1.0.0`.

  No functional change to any package's runtime behaviour or public
  API — `package.json` metadata only.

- Updated dependencies [[`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035)]:
  - @nestjs-transactional/core@1.0.0-alpha.3

## 1.0.0-alpha.2

### Minor Changes

- [#6](https://github.com/igorgolovanov/nestjs-transactional/pull/6) [`d9c80d3`](https://github.com/igorgolovanov/nestjs-transactional/commit/d9c80d38e238da9e593bcecbbfb4a7ea7f82c18b) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Lift the singleton-handler restriction in `CqrsHandlerWrapper`.

  `@CommandHandler` / `@QueryHandler` / `@EventsHandler` classes
  declared with `{ scope: Scope.REQUEST }` or
  `{ scope: Scope.TRANSIENT }` now compose with `@Transactional` —
  including the common request-scoped pattern where the handler
  injects `@nestjs/cqrs`'s `AsyncContext` via `@Inject(REQUEST)` to
  carry per-request data (user, geo, A/B flags, ...).

  The wrap target moved from the resolved handler **instance** to the
  handler class **prototype**, intercepting `@nestjs/cqrs`'s
  late-bound `instance.execute(query)` / `instance.handle(event)`
  lookup regardless of how the instance is resolved. The
  `@Transactional` decorator surface, propagation modes, defaults
  (`defaultQueryOptions`, `defaultCommandOptions`), event-dispatcher
  semantics, and the `WRAPPED_MARKER` double-wrap protection are
  unchanged. Singleton handlers behave identically.

  A test-isolation API ships alongside:
  `CqrsHandlerWrapper.resetForTesting()` static restores wrapped
  prototypes between cases. `CqrsHandlerWrapper` also implements
  `OnModuleDestroy` and calls the same cleanup automatically on
  `module.close()`, so existing test suites do not need a per-`it`
  reset to stay green.

  Rationale and full design: see [ADR-020](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/020-prototype-level-cqrs-wrapping.md).

  Known edge case: handlers defined with an arrow-function instance
  field (`execute = async (q) => {...}`) are not wrapped — the
  method shadows the prototype. Use regular method syntax
  (`async execute(q) { ... }`) so the method lives on the prototype.

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

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

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
