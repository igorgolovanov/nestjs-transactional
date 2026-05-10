# @nestjs-transactional/outbox

## 1.0.0-alpha.0

### Minor Changes

- [`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  Persistent Event Publication Registry — Spring Modulith
  `@ApplicationModuleListener` durability semantics for NestJS.
  - `EventPublication` lifecycle states (`PUBLISHED`, `PROCESSING`,
    `COMPLETED`, `FAILED`, `RESUBMITTED`).
  - `EventPublicationRepository` SPI; `InMemoryEventPublicationRepository`
    shipped for tests.
  - `EventTypeRegistry` for cross-restart deserialization.
  - `OutboxListenerRegistry` and class-level `@OutboxEventsHandler`
    decorator (ADR-014). Stable listener id format
    `${baseId}#${EventName}` for rename safety (ADR-009).
  - `OutboxEventPublisher` — smart facade detecting active dataSource
    via `TransactionContext` (DD-024). Multi-DS routing via per-event
    registry plus explicit override.
  - `EventPublicationProcessor` async worker; `StalenessMonitor`
    detects publications stuck in `PROCESSING`;
    `StartupRecoveryService` republishes on restart.
  - Operator APIs: `FailedEventPublications` (with `resubmit(...)`),
    `IncompleteEventPublications`, `CompletedEventPublications`.
  - Completion modes: `UPDATE`, `DELETE`, `ARCHIVE`.
  - `@Externalized` SPI + `EventExternalizer` structural port (DD-018)
    for broker delivery — concrete implementations in
    `@nestjs-transactional/outbox-microservices`.
  - `OutboxModule.forRoot({ ... dataSource? })` /
    `OutboxModule.forFeature(events, { dataSource? })` — multi-`forRoot`
    pattern (ADR-019); per-DS event-type registries; static-class
    storage coordinates singletons across calls.
  - `OutboxProcessingModule` for worker processes.
  - `/testing` subpath: `PublishedEvents` and
    `AssertablePublishedEvents` mirror Spring Modulith's helpers.

  Peer deps: `@nestjs-transactional/core`. Persistence backends ship
  separately (`outbox-typeorm`); the in-memory repo is sufficient for
  unit tests. Public alpha.

### Patch Changes

- Updated dependencies [[`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
