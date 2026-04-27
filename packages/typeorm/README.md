# @nestjs-transactional/typeorm

TypeORM adapter for [@nestjs-transactional/core](../core).

## Overview

Provides:

- `TypeOrmTransactionAdapter` — implements the core `TransactionAdapter` port over TypeORM's `DataSource`. Handles BEGIN / COMMIT / ROLLBACK via `DataSource.transaction(...)` and issues raw `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` SQL for nested transactions.
- `getCurrentEntityManager(adapterInstance?, fallback?)` — helper that returns the transaction-aware `EntityManager` from the current async context, or falls back to `dataSource.manager` outside a transaction.
- `isInTransaction(adapterInstance?)` — predicate for the current context.
- `TypeOrmTransactionalModule.forFeature({ dataSourceName, dataSource, isDefault })` — NestJS dynamic module that registers an adapter instance with the core `AdapterRegistry`.
- Multi-datasource: register multiple `forFeature` entries under distinct `dataSourceName`s.

## Installation

```bash
npm install @nestjs-transactional/typeorm @nestjs-transactional/core typeorm @nestjs/typeorm reflect-metadata
```

## Quick start

Minimal single-DataSource setup:

```ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [User],
      synchronize: false,
    }),
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forFeature({
      dataSource: () => DataSource.prototype.initialize.call(/* ... */),
      isDefault: true,
    }),
  ],
})
export class AppModule {}
```

**Import order matters** — `TransactionalModule.forRoot({ isGlobal: true })` must be present (with `isGlobal`) so that the `AdapterRegistry` is visible inside `TypeOrmTransactionalModule`'s DI scope. Without `isGlobal`, the registration inside `forFeature` cannot find the registry and Nest reports a missing dependency.

## Usage in a repository

```ts
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrderRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async save(order: Order): Promise<Order> {
    // Inside a @Transactional scope -> returns the transactional EM.
    // Outside one -> returns ds.manager (autocommit).
    const em = getCurrentEntityManager('default', this.ds);
    return em.save(Order, order);
  }
}
```

Then annotate the method that owns the unit of work:

```ts
@Injectable()
export class OrderService {
  constructor(private readonly orders: OrderRepository) {}

  @Transactional()
  async placeOrder(dto: PlaceOrderDto): Promise<Order> {
    return this.orders.save(/* ... */);
  }
}
```

## Multi-datasource

```ts
@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forFeature({
      dataSourceName: 'primary',
      dataSource: primaryDs,
      isDefault: true,
    }),
    TypeOrmTransactionalModule.forFeature({
      dataSourceName: 'billing',
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
  async chargeCard(/* ... */) {
    const em = getCurrentEntityManager('billing');
    /* writes go to the billing DataSource */
  }
}
```

Each `forFeature` call registers its adapter under `typeorm:${dataSourceName}` in the core `AdapterRegistry`. `TransactionManager` routes based on `options.dataSource` (Phase 14.2 syntax) or the legacy `options.adapterInstance`.

## Testing

### Unit tests — in-memory SQLite

For fast unit tests that don't need a real database, use TypeORM's `sqljs` driver:

```ts
import { DataSource } from 'typeorm';
import { TypeOrmTransactionAdapter } from '@nestjs-transactional/typeorm';

const ds = new DataSource({
  type: 'sqljs',
  synchronize: true,
  entities: [YourEntity],
});
await ds.initialize();

const adapter = new TypeOrmTransactionAdapter(ds, 'default');
```

### Integration tests — testcontainers-node + real Postgres

Bundled helper for real Postgres integration:

```ts
import {
  startPostgresContainer,
  stopPostgresContainer,
  createAdditionalDatabase,
} from '@nestjs-transactional/typeorm/test/setup-testcontainers';

let ctx;
beforeAll(async () => {
  ctx = await startPostgresContainer({ entities: [User], synchronize: true });
});
afterAll(async () => {
  await stopPostgresContainer(ctx);
});

// Multi-DS: a second database inside the same container
const secondary = await createAdditionalDatabase(ctx, 'billing_test', {
  entities: [User],
  synchronize: true,
});
```

Run integration tests:

```bash
pnpm --filter @nestjs-transactional/typeorm test:integration
```

The bundled `docker-compose.yml` is for manual local use (`psql` against a persistent instance). Testcontainers manages its own containers and does not require compose.

## Savepoints and NESTED propagation

When a method uses `PropagationMode.NESTED` from inside an existing TypeORM transaction, the adapter issues a `SAVEPOINT sp_<uuid-30>` statement. Rollback rolls back to the savepoint; the outer transaction continues. Savepoint names are at most 33 characters long — valid on Postgres, MySQL, MariaDB, SQLite, and Oracle's identifier limit.

## Status

Work in progress. Not yet published to npm.
