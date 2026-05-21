# @nestjs-transactional/typeorm

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

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  TypeORM adapter for `@nestjs-transactional/core`:
  - `TypeOrmTransactionAdapter` — implements the core
    `TransactionAdapter` SPI over `DataSource.transaction(...)`. Issues
    raw `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT`
    SQL for `NESTED` propagation. Compatible with Postgres, MySQL,
    MariaDB, SQLite, and Oracle savepoint identifier limits.
  - **Transparent transactional repositories (Phase 14.20)** —
    `@InjectRepository(Entity)` Repositories automatically dispatch
    through the active `@Transactional()` scope's `EntityManager`. No
    `getCurrentEntityManager()` calls in user service code. Covers
    `repo.save(...)`, all 30+ Repository operations, custom
    `Repository.extend(...)` classes, `TreeRepository`, plus
    `@InjectEntityManager() em.getRepository(E).save(...)` and
    `@InjectDataSource() ds.getRepository(E).save(...)` patterns.
  - `getCurrentEntityManager(adapterInstance?, fallback?)` and
    `isInTransaction(adapterInstance?)` escape-hatch helpers for the
    documented limitations (`@InjectEntityManager() em.save(...)`
    direct call, `BaseEntity.useDataSource` static API).
  - `TypeOrmTransactionalModule.forRoot({ dataSource?, isDefault? })`
    and `forRootAsync({...})` — multi-`forRoot` per dataSource (ADR-018);
    the underlying `DataSource` resolves from DI under
    `getDataSourceToken(name)` matching `@nestjs/typeorm` conventions.

  Peer deps: `@nestjs-transactional/core`, `typeorm ^0.3.25`,
  `@nestjs/typeorm ^10.0.0 || ^11.0.0`. Public alpha.

### Patch Changes

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
