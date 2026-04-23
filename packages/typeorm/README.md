# @nestjs-transactional/typeorm

TypeORM adapter for [@nestjs-transactional/core](../core).

Provides:

- `TypeOrmTransactionAdapter` — implements the `TransactionAdapter` port over TypeORM's `DataSource` / `QueryRunner`.
- `getCurrentEntityManager(adapterInstance?, fallback?)` — helper that returns the transaction-aware `EntityManager` from the current async context, or falls back to `dataSource.manager` outside a transaction.
- `isInTransaction(adapterInstance?)` — predicate for the current context.
- `TypeOrmTransactionalModule.forFeature({ instanceName, dataSource, isDefault })` — registers an adapter instance with the core `AdapterRegistry`.
- Savepoint support for `PropagationMode.NESTED`.
- First-class multi-datasource: register multiple adapter instances under distinct names.

Requires `@nestjs-transactional/core` and `typeorm` as peer dependencies.

## Status

Work in progress. Not yet published to npm.
