# @nestjs-transactional/typeorm

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Ftypeorm/alpha?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/typeorm)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

TypeORM adapter for
[`@nestjs-transactional/core`](https://www.npmjs.com/package/@nestjs-transactional/core).

Two things come with it. The adapter itself, which maps `@Transactional()`
onto TypeORM's transactions and savepoints — and **transparent
transactional repositories**: your existing `@InjectRepository(Order)`
instances start honouring the active transaction on their own, with no
change to the code that uses them.

```ts
@Injectable()
export class OrderService {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  @Transactional()
  async place(dto: PlaceOrderDto) {
    // Runs in the transaction. Rolls back if anything below throws.
    // Outside a @Transactional method, the same call autocommits.
    return this.orders.save(dto);
  }
}
```

No `getCurrentEntityManager()`, no passing an `EntityManager` down
through service layers, no separate "transactional" repository type.

> **Alpha.** The public API is stable in intent but may still change
> before `1.0.0`.

## Install

```bash
pnpm add @nestjs-transactional/typeorm @nestjs-transactional/core typeorm @nestjs/typeorm reflect-metadata
```

## Quick start

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'postgres', entities: [Order] }),
    TypeOrmModule.forFeature([Order]),

    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot(),
  ],
})
export class AppModule {}
```

`TransactionalModule.forRoot({ isGlobal: true })` has to be there, with
`isGlobal` — that is how this module sees the core registry from its own
DI scope. The `DataSource` is found through `@nestjs/typeorm`'s
`getDataSourceToken(name)`, the same convention
`@InjectRepository(E, dataSource)` uses, so nothing else needs wiring.

## What becomes transparent

These all dispatch through the active transaction:

- `@InjectRepository(Entity)` — the common case.
- `@InjectEntityManager() em.getRepository(E)`.
- `@InjectDataSource() ds.getRepository(E)` and `ds.manager`.
- Custom repositories built with `Repository.extend(...)`.
- `TreeRepository` and `MongoRepository`, which inherit from `Repository`.

Two patterns are **not** covered, and need an escape hatch:

1. **`em.save(Entity, ...)` called directly** on an injected
   `EntityManager`. The patch covers `em.getRepository(E).save(...)`,
   not the manager's own data methods — patching all ~14 of them would
   require per-method recursion guards, which was judged not worth the
   surface area.
2. **`BaseEntity` static methods** (`User.save(...)`).
   `BaseEntity.useDataSource(...)` captures a `DataSource` reference
   that bypasses the patch. The library `typeorm-transactional` has the
   same limitation.

For both, either use a repository or reach for the escape hatch:

```ts
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';

@Transactional()
async runRawSql() {
  // Pass the DataSource as fallback so this also works outside a
  // transaction, where it returns ds.manager.
  const em = getCurrentEntityManager('default', this.ds);
  await em.query('UPDATE accounts SET balance = balance - $1', [100]);
}
```

## Dialect-dependent behaviour

Two options behave differently per database, and both fail loudly or
harmlessly rather than surprisingly:

- **`readOnly`** is enforced on `postgres`, `cockroachdb` and
  `aurora-postgres`, where the adapter issues `SET TRANSACTION READ ONLY`
  as the transaction's first statement and the database refuses a write.
  On other dialects it is a silent no-op. MySQL is not merely
  unimplemented but unimplementable: `SET TRANSACTION` there applies to
  the *next* transaction and errors inside a started one. Worth knowing
  if you develop on SQLite and deploy to Postgres — the constraint
  appears in production for the first time.
  ([DD-027](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/027-readonly-and-timeout-semantics.md))
- **`PropagationMode.NESTED`** needs savepoints. The adapter checks
  TypeORM's own `driver.transactionSupport` flag and throws
  `IllegalTransactionStateError` naming the driver and the alternatives,
  instead of running your "nested" transaction as part of the outer one.

## Multiple dataSources

One `forRoot` call per dataSource:

```ts
TypeOrmTransactionalModule.forRoot({ isDefault: true }),        // 'default'
TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),  // 'billing'
```

```ts
@Transactional({ dataSource: 'billing' })
async chargeCard() {
  return this.invoiceRepo.save(/* ... */); // repo bound to 'billing'
}
```

A repository bound to dataSource A, used inside a
`@Transactional({ dataSource: 'B' })` method, autocommits: its patched
manager looks for an active transaction on A, finds none, and falls back
to its original manager. **Distributed transactions across dataSources
are not supported** — that is deliberate, and cross-dataSource atomicity
is what the outbox is for.

## Async configuration

```ts
TypeOrmTransactionalModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    dataSource: cfg.get('DATA_SOURCE_NAME', 'default'),
    isDefault: true,
  }),
});
```

Registration is deferred to `OnModuleInit` so the dataSource resolves
correctly even when paired with `TypeOrmModule.forRootAsync`. Per-dataSource
adapter tokens are not registered on this path, because NestJS needs
provider tokens at module-definition time; use sync `forRoot({ dataSource })`
if you inject adapters by token.

## Compatibility

| Peer | Supported range |
| --- | --- |
| Node.js | `>=22.13.0` |
| `typeorm` | `^0.3.0 \|\| ^1.0.0` |
| `@nestjs/typeorm` | `^10.0.0 \|\| ^11.0.0` |
| `@nestjs/common` / `@nestjs/core` | `^10.0.0 \|\| ^11.0.0` |
| `reflect-metadata` | `^0.1.13 \|\| ^0.2.0` |
| `rxjs` | `^7.0.0` |

Both stable TypeORM lines are supported. CI runs the full unit and
integration matrix — including savepoints and isolation against a real
Postgres — at three points of that range: `0.3.31`, `1.0.0` and `1.1.0`.

## Testing

For unit tests, TypeORM's in-memory `sqljs` driver is enough:

```ts
const ds = new DataSource({ type: 'sqljs', synchronize: true, entities: [Order] });
await ds.initialize();
const adapter = new TypeOrmTransactionAdapter(ds, 'default');
```

Note that `readOnly` is not enforced on `sqljs`, so a read-only
violation your tests miss can still surface on Postgres. For tests that
need real dialect behaviour, run Postgres through
[testcontainers](https://node.testcontainers.org/); the
[`testing-patterns`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/testing-patterns)
example shows both layers.

## Documentation

- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)
- [`readOnly` and `timeout` semantics (DD-027)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/027-readonly-and-timeout-semantics.md)
- [Multi-adapter architecture (ADR-018)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/018-multi-adapter-architecture.md)
- [Known limitations](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/known-limitations.md)
- Runnable examples:
  [`basic-transactional`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/basic-transactional),
  [`multi-datasource-basic`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/multi-datasource-basic),
  [`read-write-separation`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/read-write-separation),
  [`e-commerce-orders`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/e-commerce-orders)

## License

MIT
