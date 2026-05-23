# @nestjs-transactional/outbox-typeorm

## 1.0.0-alpha.4

### Patch Changes

- [#10](https://github.com/igorgolovanov/nestjs-transactional/pull/10) [`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Pass `--tag alpha` to `changeset publish` in the release script.

  Previous attempt declared `publishConfig.tag = "alpha"` in each
  package's `package.json`. The metadata reached the npm registry,
  but `@changesets/cli publish` overrides it with its own `--tag`
  argument (defaulting to `latest`), so every pre-release after
  `1.0.0-alpha.0` continued to land in the `latest` dist-tag while
  `alpha` stayed pinned to the initial version.

  The fix is a single CLI flag in the root `release` script:

  ```diff
  - "release": "changeset publish"
  + "release": "changeset publish --tag alpha"
  ```

  `changesets/action` invokes this script from the Release workflow,
  so the flag propagates to every package in the same publish run.
  The previously-added `publishConfig.tag` stays in place as
  declarative metadata for direct `npm publish` callers (where it
  still applies); it will be removed alongside the `--tag alpha`
  flag during `pnpm changeset pre exit` for stable `1.0.0`.

  No functional / API change — release infrastructure only.

- Updated dependencies [[`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9)]:
  - @nestjs-transactional/core@1.0.0-alpha.4
  - @nestjs-transactional/typeorm@1.0.0-alpha.4
  - @nestjs-transactional/outbox@1.0.0-alpha.4

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
  - @nestjs-transactional/typeorm@1.0.0-alpha.3
  - @nestjs-transactional/outbox@1.0.0-alpha.3

## 1.0.0-alpha.1

### Minor Changes

- [#4](https://github.com/igorgolovanov/nestjs-transactional/pull/4) [`60872c3`](https://github.com/igorgolovanov/nestjs-transactional/commit/60872c32aae289e161382b01832c2be019d74536) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Support TypeORM 1.0 alongside 0.3.x.

  The TypeORM peer-dependency range is widened to
  `^0.3.0 || ^1.0.0`, covering the stable `0.3.x` and `1.x` lines.
  TypeORM nightly / beta pre-release channels stay outside the
  declared range; consumers who need them can install through
  `pnpm.overrides`.

  Internal compatibility: the patching layer reads the owning
  `DataSource` from an `EntityManager` through a small helper
  (`getEmDataSource`) that handles the 0.3.x → 1.0 rename
  (`EntityManager.connection` → `EntityManager.dataSource`). All
  other touchpoints (`QueryRunner`, schema-builder `Table` /
  `TableIndex`, `MigrationInterface`, ORM decorators) are
  behaviourally unchanged across the two majors. CI now runs the
  full unit + integration matrix on both TypeORM versions.

  `engines.node` for these two packages is bumped to `>=22.13.0`
  to match TypeORM 1.0's minimum on the Node 22 line.

### Patch Changes

- Updated dependencies [[`60872c3`](https://github.com/igorgolovanov/nestjs-transactional/commit/60872c32aae289e161382b01832c2be019d74536)]:
  - @nestjs-transactional/typeorm@1.0.0-alpha.1

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

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

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
  - @nestjs-transactional/outbox@1.0.0-alpha.0
  - @nestjs-transactional/typeorm@1.0.0-alpha.0
