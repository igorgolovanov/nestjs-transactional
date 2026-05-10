# @nestjs-transactional/outbox-typeorm

## 1.0.0-alpha.0

### Minor Changes

- [`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  TypeORM persistence backend for `@nestjs-transactional/outbox`:
  - `EventPublicationEntity` (`event_publication` hot table) with four
    worker / operator / cleanup indexes:
    `(status, publicationDate)`, `(status, listenerId)`, `(eventType)`,
    `(completionDate)`. `status` is `varchar(32)` (not Postgres `enum`)
    to keep new lifecycle states from forcing a type migration.
  - `EventPublicationArchiveEntity` (`event_publication_archive`) for
    the `ARCHIVE` completion mode — same columns minus the nullability
    of `completionDate`.
  - `TypeOrmEventPublicationRepository` implementing the SPI:
    - `findReadyForProcessing` uses
      `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent worker
      safety.
    - `tryClaim` issues a single conditional `UPDATE` for atomic
      `PUBLISHED|RESUBMITTED → PROCESSING` transitions.
    - All reads/writes go through `getCurrentEntityManager` so
      publication rows commit atomically with the business write
      (DD-019 single-unit atomicity).
  - `OutboxTypeOrmModule.forRoot({ dataSource?, schemaInitialization?, isGlobal? })`
    and `forRootAsync({...})` — Phase 14.21 reshape mirroring
    `TypeOrmTransactionalModule.forRoot`. The underlying `DataSource`
    resolves from DI via `getDataSourceToken(name)`.
  - Cross-module bridge `typeOrmEventPublicationRepositoryProvider({ dataSource? })`
    forwarding the per-DS repository token to the `outbox` package.
  - Schema management: shipped TypeORM migration
    `CreateEventPublication1700000000000` for production (preferred);
    `SchemaInitializer` for development-time auto-init at bootstrap.

  Peer deps: `@nestjs-transactional/core`, `@nestjs-transactional/typeorm`,
  `@nestjs-transactional/outbox`, `typeorm ^0.3.25`,
  `@nestjs/typeorm ^10.0.0 || ^11.0.0`. Public alpha.

### Patch Changes

- Updated dependencies [[`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897), [`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897), [`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
  - @nestjs-transactional/outbox@1.0.0-alpha.0
  - @nestjs-transactional/typeorm@1.0.0-alpha.0
