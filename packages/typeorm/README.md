# @nestjs-transactional/typeorm

TypeORM adapter for [@nestjs-transactional/core](../core).

## Overview

Provides:

- `TypeOrmTransactionAdapter` — implements the core `TransactionAdapter` port over TypeORM's `DataSource` / `QueryRunner`. Handles BEGIN / COMMIT / ROLLBACK, forwards the SQL isolation level, and implements `runInSavepoint` via raw `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` SQL.
- `getCurrentEntityManager(adapterInstance?, fallback?)` — helper that returns the transaction-aware `EntityManager` from the current async context, or falls back to `dataSource.manager` outside a transaction.
- `isInTransaction(adapterInstance?)` — predicate for the current context.
- `TypeOrmTransactionalModule.forFeature({ instanceName, dataSource, isDefault })` — NestJS dynamic module that registers an adapter instance with the core `AdapterRegistry`.
- Multi-datasource: register multiple `forFeature` entries under distinct `instanceName`s.

## Installation

```bash
npm install @nestjs-transactional/typeorm @nestjs-transactional/core typeorm @nestjs/typeorm reflect-metadata
```

## Quick start

```ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

const dataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [],
});

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forFeature({
      dataSource: () => dataSource.initialize(),
    }),
  ],
})
export class AppModule {}
```

`TransactionalModule.forRoot()` must be imported alongside (or before) `TypeOrmTransactionalModule.forFeature()` — the core module provides the `AdapterRegistry` that this module registers against.

**Important:** pass `{ isGlobal: true }` to `TransactionalModule.forRoot()` when you use `TypeOrmTransactionalModule.forFeature()`. NestJS's DI scopes providers by module, so without `@Global` the `TypeOrmAdapterRegistrar` inside `TypeOrmTransactionalModule` cannot see the `AdapterRegistry` exported by `TransactionalModule`. With `isGlobal: true` the registry becomes visible everywhere.

## Usage in a repository

```ts
import { Injectable } from '@nestjs/common';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrderRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async save(order: Order): Promise<Order> {
    const em = getCurrentEntityManager('default', this.ds);
    return em.save(Order, order);
  }
}
```

When called from inside a `@Transactional`-decorated path, `getCurrentEntityManager` returns the transaction's `EntityManager` — the write joins the transaction. When called outside, it falls back to `this.ds.manager` — the write executes autocommit. Pass no fallback to assert that the caller must be transactional.

## Multi-datasource

```ts
@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forFeature({
      instanceName: 'primary',
      dataSource: primaryDs,
    }),
    TypeOrmTransactionalModule.forFeature({
      instanceName: 'billing',
      dataSource: billingDs,
    }),
  ],
})
export class AppModule {}
```

Target a specific instance in a transactional method:

```ts
import { TransactionalOn } from '@nestjs-transactional/core';

@Injectable()
export class BillingService {
  @TransactionalOn('billing')
  async chargeCard(/* ... */) { /* ... */ }
}
```

## Testing

### Unit tests (in-memory SQLite)

For fast unit tests that don't need a real database:

```ts
import { DataSource } from 'typeorm';
import { TypeOrmTransactionAdapter } from '@nestjs-transactional/typeorm';

const ds = new DataSource({
  type: 'sqljs',
  synchronize: false,
  entities: [YourEntity],
});
await ds.initialize();

const adapter = new TypeOrmTransactionAdapter(ds);
```

### Integration tests (testcontainers-node)

For tests against a real Postgres, use the bundled testcontainers helper:

```ts
import { startPostgresContainer, stopPostgresContainer } from '@nestjs-transactional/typeorm/test/setup-testcontainers';

let ctx;
beforeAll(async () => { ctx = await startPostgresContainer(); });
afterAll(async () => { await stopPostgresContainer(ctx); });
```

Run integration tests via the dedicated Jest config:

```bash
pnpm --filter @nestjs-transactional/typeorm test:integration
```

Testcontainers manages its own Docker containers — no `docker compose` required. The bundled `docker-compose.yml` is only for manual development use (running `psql` against a persistent local instance).

## Savepoints and NESTED propagation

When a method uses `PropagationMode.NESTED` from inside an existing TypeORM transaction, the adapter issues a `SAVEPOINT sp_<uuid>` statement. A rollback rolls back to that savepoint; the outer transaction continues. Savepoint names are 34-character SQL identifiers — valid on Postgres, MySQL, MariaDB, and SQLite.

## Status

Work in progress. Not yet published to npm.
