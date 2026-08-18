# @nestjs-transactional/core

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Fcore/alpha?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

Declarative transactions for NestJS, with Spring's semantics.

Put `@Transactional()` on a method and everything it touches runs in
one transaction — across `await` boundaries, without threading a
manager through your call stack. All seven Spring propagation modes are
implemented, including `NESTED` via savepoints.

This package is ORM-agnostic and does nothing on its own: it needs an
adapter. Most applications install
[`@nestjs-transactional/typeorm`](https://www.npmjs.com/package/@nestjs-transactional/typeorm)
alongside it, which also makes injected repositories transaction-aware
automatically. For event delivery that survives a crash, add
[`@nestjs-transactional/outbox`](https://www.npmjs.com/package/@nestjs-transactional/outbox);
for `@nestjs/cqrs` handlers,
[`@nestjs-transactional/cqrs`](https://www.npmjs.com/package/@nestjs-transactional/cqrs).

> **Alpha.** The public API is stable in intent but may still change
> before `1.0.0`.

## Install

```bash
pnpm add @nestjs-transactional/core @nestjs-transactional/typeorm reflect-metadata
```

Load `reflect-metadata` once at your entry point, as NestJS itself
requires.

## Quick start

```ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      /* ... */
    }),

    // Infrastructure only: TransactionManager, AdapterRegistry, the
    // interceptor. `isGlobal` matters — the adapter package below
    // needs to see the registry from its own DI scope.
    TransactionalModule.forRoot({ isGlobal: true }),

    // Registers the TypeORM adapter for the default dataSource.
    TypeOrmTransactionalModule.forRoot(),
  ],
})
export class AppModule {}
```

That is the whole setup. Now any method — a controller handler, a
service method, a CQRS handler — becomes transactional by decoration:

```ts
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';

@Injectable()
export class OrdersService {
  @Transactional()
  async placeOrder(dto: PlaceOrderDto): Promise<Order> {
    const order = await this.orders.save(dto);
    await this.stock.reserve(order); // same transaction
    return order; // commits here; a throw rolls both back
  }
}
```

## Propagation

`@Transactional({ propagation })` decides what happens when a
transactional method is called from inside another one. The default,
`REQUIRED`, joins the caller — which is what you want almost always.

| Mode | Caller has a transaction | Caller has none |
| --- | --- | --- |
| `REQUIRED` *(default)* | join it | start one |
| `REQUIRES_NEW` | suspend it, run independently, resume | start one |
| `NESTED` | run in a savepoint | start one |
| `SUPPORTS` | join it | run without a transaction |
| `NOT_SUPPORTED` | suspend it, run without one, resume | run without one |
| `NEVER` | throw `IllegalTransactionStateError` | run without one |
| `MANDATORY` | join it | throw `IllegalTransactionStateError` |

`REQUIRES_NEW` is how you make a side effect survive the caller's
rollback — an audit row that must persist even when the operation
fails. `NESTED` gives you a partial rollback inside one transaction;
it needs a driver with savepoint support, and the TypeORM adapter
raises a clear error rather than silently degrading if the driver has
none.

## Options

```ts
class ReportsService {
  @Transactional({
    propagation: PropagationMode.REQUIRES_NEW,
    isolation: 'SERIALIZABLE',
  })
  async rebuild() {}

  // Roll back on anything except ValidationError.
  @Transactional({ noRollbackFor: [ValidationError] })
  async processBatch() {}

  // Shorthand for { readOnly: true }.
  @ReadOnly()
  async exportCsv() {}

  // Target one dataSource in a multi-dataSource application.
  @TransactionalOn('billing')
  async chargeCard() {}
}
```

Two options carry caveats worth knowing before you rely on them:

- **`readOnly`** is enforced by the database only on Postgres-family
  dialects, where the adapter issues `SET TRANSACTION READ ONLY`.
  Elsewhere it documents intent and nothing rejects a write. Spring
  treats it as a hint too. See
  [DD-027](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/027-readonly-and-timeout-semantics.md).
- **`timeout`** is accepted by the type but **not implemented** by the
  TypeORM adapter. It is deliberately not approximated: Postgres'
  `statement_timeout` bounds each statement rather than the
  transaction, so `timeout: 5000` on a method issuing four queries
  would allow twenty seconds. It stays in the surface for adapters
  whose driver exposes a real transaction budget.

## Commit and rollback hooks

Register from inside a transactional method; the hook binds to the
transaction currently running.

```ts
@Transactional()
async placeOrder(dto: PlaceOrderDto) {
  const order = await this.orders.save(dto);

  // Runs only after the commit succeeds — never on rollback.
  this.manager.registerAfterCommit(() => this.analytics.track(order.id));

  // Receives the error that caused the rollback.
  this.manager.registerAfterRollback((error) => this.metrics.failed(error));

  return order;
}
```

A throwing hook is logged and swallowed: it changes neither the
transaction's outcome nor its sibling hooks. For event handlers with
these semantics as first-class decorators, see the `cqrs` package.

## Testing

`InMemoryTransactionAdapter` from the `/testing` subpath records
commits, rollbacks and savepoints without a database:

```ts
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';

const adapter = new InMemoryTransactionAdapter();

await Test.createTestingModule({
  imports: [TransactionalModule.forRoot({ isGlobal: true, adapter })],
}).compile();

expect(adapter.committedTransactions).toHaveLength(1);
expect(adapter.rolledBackTransactions).toHaveLength(0);
```

`adapter.reset()` clears the arrays between cases. Pass a dataSource
name to the constructor for multi-dataSource tests.

## Custom adapters

To support another ORM, implement `TransactionAdapter<THandle>` and
hand it to `forRoot` directly:

```ts
TransactionalModule.forRoot({ isGlobal: true, adapter: myAdapter });
```

One `forRoot` call registers one adapter. Multi-dataSource
applications call it once per dataSource.

## Documentation

- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)
- [Architecture: core design](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/architecture/core-design.md)
- [How methods get wrapped (ADR-005)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/005-method-wrapping-strategy.md)
- [Known limitations](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/known-limitations.md)
- Runnable examples:
  [`basic-transactional`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/basic-transactional),
  [`testing-patterns`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/testing-patterns)

## License

MIT
