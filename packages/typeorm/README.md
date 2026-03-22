# @nestjs-transactional/typeorm

TypeORM adapter for [@nestjs-transactional/core](../core).

## Overview

Provides:

- `TypeOrmTransactionAdapter` — implements the core `TransactionAdapter` port over TypeORM's `DataSource`. Handles BEGIN / COMMIT / ROLLBACK via `DataSource.transaction(...)` and issues raw `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT` SQL for nested transactions.
- **Transparent transactional repositories (Phase 14.20)** — `@InjectRepository(Entity)` instances, `@InjectEntityManager() em.getRepository(E)`, `@InjectDataSource() ds.manager.save(...)` and `ds.getRepository(E).save(...)` automatically dispatch through the active `@Transactional()` scope's `EntityManager` — no `getCurrentEntityManager()` boilerplate. Custom repositories via `Repository.extend(...)` and `TreeRepository` work transparently. See [Transparent transactional behaviour](#transparent-transactional-behaviour) below.
- `getCurrentEntityManager(adapterInstance?, fallback?)` — helper that returns the transaction-aware `EntityManager` from the current async context, or falls back to `dataSource.manager` outside a transaction. Now mostly an escape hatch for the documented limitations below.
- `isInTransaction(adapterInstance?)` — predicate for the current context.
- `TypeOrmTransactionalModule.forRoot({ dataSource?, isDefault? })` — NestJS dynamic module that activates the transparent patches and registers an adapter with the core `AdapterRegistry`. The `DataSource` itself is resolved from DI under `getDataSourceToken(dataSource)` (the same convention `@nestjs/typeorm` uses for `@InjectRepository(E, dataSource)`).
- `TypeOrmTransactionalModule.forRootAsync({ useFactory, inject?, imports? })` — async variant for `ConfigService`-driven setups.
- Multi-datasource: call `forRoot` once per dataSource, mirroring `OutboxModule` (ADR-019) and `TransactionalModule` (Phase 14.10).

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

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [User],
      synchronize: false,
    }),
    TypeOrmModule.forFeature([User]),

    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot(),
  ],
})
export class AppModule {}
```

**Import order matters** — `TransactionalModule.forRoot({ isGlobal: true })` must be present (with `isGlobal`) so that the `AdapterRegistry` is visible inside `TypeOrmTransactionalModule`'s DI scope. The actual `DataSource` is resolved by `@nestjs/typeorm`'s `getDataSourceToken(name)` — `TypeOrmModule.forRoot(...)` registers it globally, so `TypeOrmTransactionalModule.forRoot` can find it.

## Transparent transactional behaviour

Once the module is imported, every Repository reachable through the standard `@nestjs/typeorm` injection paths automatically dispatches through the active `@Transactional()` scope. No `getCurrentEntityManager()` calls in user code:

```ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';
import { Order } from './order.entity';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
  ) {}

  @Transactional()
  async placeOrder(dto: PlaceOrderDto): Promise<Order> {
    // `orderRepo.save(...)` automatically uses the transactional
    // EntityManager. If the method throws, the save rolls back.
    // Outside a @Transactional scope, the same call autocommits.
    return this.orderRepo.save(dto);
  }
}
```

Supported transparent patterns:

- `@InjectRepository(Entity) repo` — the headline case.
- `@InjectEntityManager() em.getRepository(E).save(...)`.
- `@InjectDataSource() ds.getRepository(E).save(...)`.
- `@InjectDataSource() ds.manager.save(Entity, ...)` (the patched DataSource manager getter routes through the active EM).
- Custom repositories via `Repository.extend(...)`.
- `TreeRepository` and `MongoRepository` (inherit from `Repository`).

### Documented limitations

Two patterns are NOT covered by the patches and require an escape hatch:

1. **`@InjectEntityManager() em.save(Entity, ...)` direct call** is NOT transactional. The patches cover `em.getRepository(E).save(...)` (the typical pattern) but not direct method calls on the injected `EntityManager`. Use the Repository pattern instead, or call `getCurrentEntityManager()`:

   ```ts
   @Transactional()
   async createUser(name: string) {
     // Option A — Repository pattern (recommended).
     return this.em.getRepository(User).save({ name });

     // Option B — escape hatch.
     // const em = getCurrentEntityManager();
     // return em.save(User, { name });
   }
   ```

2. **`BaseEntity` static methods** (`User.save(...)` etc.) are NOT supported. The `BaseEntity.useDataSource(...)` API stores a captured DataSource reference that bypasses the patches. Use the Repository pattern.

The escape hatch:

```ts
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';

@Injectable()
export class RawSqlService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Transactional()
  async runRawSql() {
    // Pass `ds` as fallback so the helper returns ds.manager when
    // no transaction is active (autocommit). Inside a tx, returns
    // the transactional EM.
    const em = getCurrentEntityManager('default', this.ds);
    await em.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [100, 1]);
  }
}
```

## Multi-datasource

```ts
@Module({
  imports: [
    TypeOrmModule.forRoot({ name: 'default', /* ... */ }),
    TypeOrmModule.forRoot({ name: 'billing',  /* ... */ }),

    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot({ isDefault: true }),       // 'default'
    TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }), // 'billing'
  ],
})
export class AppModule {}
```

Target a specific dataSource in a transactional method:

```ts
import { Transactional } from '@nestjs-transactional/core';

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(Invoice, 'billing')
    private readonly invoiceRepo: Repository<Invoice>,
  ) {}

  @Transactional({ dataSource: 'billing' })
  async chargeCard(/* ... */) {
    // Repository is bound to 'billing' DS — saves go to billing.
    return this.invoiceRepo.save(/* ... */);
  }
}
```

**Cross-DS isolation (DD-023)**: a Repository bound to dataSource A inside a `@Transactional({ dataSource: 'B' })` method autocommits — its patched `manager` getter looks up active transaction for dataSource A, finds none, and falls back to its captured original manager. Distributed transactions across dataSources are explicitly NOT supported; cross-DS atomicity goes through the outbox.

Each `forRoot` call registers its adapter under `typeorm:${dataSource}` in the core `AdapterRegistry`. `TransactionManager` routes based on `options.dataSource` (Phase 14.2 syntax) or the legacy `options.adapterInstance`.

## Async configuration

```ts
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: 'postgres',
        url: cfg.get('DATABASE_URL'),
        entities: [User],
      }),
    }),

    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        dataSource: cfg.get('DATA_SOURCE_NAME', 'default'),
        isDefault: true,
      }),
    }),
  ],
})
export class AppModule {}
```

`forRootAsync` defers resolution of the dataSource name until the factory runs. Per-DS DI tokens (`getTransactionalAdapterToken(ds)`) are NOT registered in the async path because NestJS provider tokens must be declared statically — if you need direct adapter injection by per-DS token, use sync `forRoot({ dataSource })` instead.

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
