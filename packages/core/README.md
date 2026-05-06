# @nestjs-transactional/core

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcore/alpha?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

Core primitives for declarative Spring-style transaction management in NestJS.

## Overview

This package is the adapter-agnostic foundation of the `@nestjs-transactional` family:

- `TransactionContext` — `AsyncLocalStorage`-backed carrier that propagates the active transaction across `await` boundaries.
- `TransactionManager` — runtime with the full Spring propagation semantics (`REQUIRED`, `REQUIRES_NEW`, `NESTED`, `SUPPORTS`, `NOT_SUPPORTED`, `NEVER`, `MANDATORY`) plus `rollbackFor` / `noRollbackFor` rules and before/after commit/rollback hooks.
- `@Transactional()`, `@ReadOnly()`, `@TransactionalOn(instance)` decorators — metadata-only; wrapping is performed at runtime by coordinated mechanisms (see ADR-005 in the repo root).
- `TransactionalInterceptor` — wires `@Transactional` on controllers, resolvers, gateways, and microservice handlers via `APP_INTERCEPTOR`.
- `TransactionalModule.forRoot` / `forRootAsync` — module wiring.
- `TransactionAdapter<THandle>` port — pure interface for ORM-specific adapters.
- `InMemoryTransactionAdapter` (via `@nestjs-transactional/core/testing`) — drop-in adapter for unit tests.

This package does not depend on any concrete ORM. Install `@nestjs-transactional/typeorm` for TypeORM integration, or implement your own adapter against the `TransactionAdapter` interface.

## Installation

```bash
npm install @nestjs-transactional/core reflect-metadata
```

Load `reflect-metadata` once at the application entry point (same as for NestJS itself).

## Quick start

```ts
import { Module } from '@nestjs/common';
import {
  TransactionalModule,
  type TransactionAdapter,
} from '@nestjs-transactional/core';

// Replace with a real adapter (e.g. from @nestjs-transactional/typeorm).
const myAdapter: TransactionAdapter = /* ... */;

@Module({
  imports: [
    TransactionalModule.forRoot({
      isGlobal: true,
      adapters: [
        { adapterName: 'typeorm', instanceName: 'default', adapter: myAdapter },
      ],
    }),
  ],
})
export class AppModule {}
```

Once the module is imported, `@Transactional()` on any controller handler is wrapped in a transaction automatically:

```ts
import { Controller, Get } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get(':id')
  @Transactional()
  async findOne(@Param('id') id: string) {
    return this.orders.findById(id);
  }
}
```

## Decorator options

```ts
import {
  Transactional,
  ReadOnly,
  TransactionalOn,
  PropagationMode,
} from '@nestjs-transactional/core';

class ReportsService {
  // Explicit propagation + isolation.
  @Transactional({
    propagation: PropagationMode.REQUIRES_NEW,
    isolation: 'SERIALIZABLE',
    timeout: 10_000,
  })
  async rebuildReport() { /* ... */ }

  // Shorthand for { readOnly: true }.
  @ReadOnly()
  async exportCsv() { /* ... */ }

  // Rollback rules — commit on `ValidationError`, roll back on others.
  @Transactional({ noRollbackFor: [ValidationError] })
  async processBatch() { /* ... */ }

  // Target a specific adapter instance in multi-DataSource setups.
  @TransactionalOn('billing')
  async chargeCard() { /* ... */ }
}
```

Propagation semantics:

| Mode | Active outer transaction | No outer transaction |
| --- | --- | --- |
| `REQUIRED` (default) | join | start new |
| `REQUIRES_NEW` | suspend + start new, then resume | start new |
| `NESTED` | run inside a savepoint | start new |
| `SUPPORTS` | join | run without transaction |
| `NOT_SUPPORTED` | suspend + run without transaction, then resume | run without transaction |
| `NEVER` | throw `IllegalTransactionStateError` | run without transaction |
| `MANDATORY` | join | throw `IllegalTransactionStateError` |

## Async module configuration

```ts
import {
  TransactionalModule,
  type AdapterRegistration,
} from '@nestjs-transactional/core';

@Module({
  imports: [
    TransactionalModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        adapters: buildAdaptersFromConfig(config) satisfies AdapterRegistration[],
      }),
    }),
  ],
})
export class AppModule {}
```

`isGlobal` and `registerInterceptor` remain static top-level flags — they must be known at module definition time.

## Lifecycle hooks

Register hooks from inside a transactional method — they fire on the current transaction:

```ts
import { TransactionManager } from '@nestjs-transactional/core';

export class OrdersService {
  constructor(private readonly manager: TransactionManager) {}

  @Transactional()
  async placeOrder(payload: PlaceOrderDto) {
    const order = await this.orders.insert(payload);

    this.manager.registerAfterCommit(async () => {
      // Fires only after the adapter commits. Never on rollback.
      await this.analytics.trackOrderPlaced(order.id);
    });

    this.manager.registerAfterRollback(async (error) => {
      // Receives the error that caused the rollback.
      await this.metrics.recordFailedOrder(order.id, error);
    });

    return order;
  }
}
```

Hook errors are caught and logged via NestJS `Logger` — they do not affect the transaction outcome or prevent sibling hooks from running.

## Testing

Use the `InMemoryTransactionAdapter` exported from the `/testing` subpath for tests that need adapter-level observability without a real database:

```ts
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
import { TransactionalModule } from '@nestjs-transactional/core';

const adapter = new InMemoryTransactionAdapter();

const moduleRef = await Test.createTestingModule({
  imports: [
    TransactionalModule.forRoot({
      adapters: [
        { adapterName: 'in-memory', instanceName: 'default', adapter },
      ],
    }),
  ],
}).compile();

// After exercising the code under test:
expect(adapter.committedTransactions).toHaveLength(1);
expect(adapter.rolledBackTransactions).toHaveLength(0);
expect(adapter.savepointsReleased).toHaveLength(0);
```

`adapter.reset()` clears all observation arrays between tests when you keep a single adapter instance across cases.

## Worked examples

- [`basic-transactional`](../../examples/basic-transactional) — `@Transactional()` on a plain service.
- [`testing-patterns`](../../examples/testing-patterns) — `InMemoryTransactionAdapter` from `core/testing` plus the outbox / integration tiers.

Full catalogue: [examples/README.md](../../examples/README.md).

## Status

Work in progress. Not yet published to npm.
