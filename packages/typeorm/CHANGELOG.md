# @nestjs-transactional/typeorm

## 1.0.0-alpha.0

### Minor Changes

- [`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

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

- Updated dependencies [[`6b8c96f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6b8c96ffb81e42ef47a2b8870a41048d32940897)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
