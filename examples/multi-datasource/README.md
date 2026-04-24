# multi-datasource

NestJS application with two TypeORM DataSources (`primary`, `billing`)
and services that route transactions to a specific adapter instance via
`@Transactional({ adapterInstance })` / `@TransactionalOn(name)`.

## Run

```bash
pnpm -C examples/multi-datasource start
```

or from this directory:

```bash
pnpm start
```

## What it shows

Two independent SQLite in-memory databases are registered under distinct
adapter instance names:

```ts
TypeOrmTransactionalModule.forFeature({ dataSource: primary }),        // 'default'
TypeOrmTransactionalModule.forFeature({ instanceName: 'billing', dataSource: billing }),
```

- `OrderService.placeOrder` — `@Transactional()` (defaults to the
  `'default'` instance → `primary` DataSource).
- `BillingService.generateInvoice` — `@TransactionalOn('billing')`
  (syntactic sugar for `@Transactional({ adapterInstance: 'billing' })`).
  Runs in a transaction bound to the `billing` DataSource.

The example verifies isolation by querying the raw `sqlite_master`
catalog of each DataSource — neither knows about the other's tables.

Expected output:

```
[...] LOG [TransactionalMethodsBootstrap] Wrapped 2 @Transactional methods
=== multi-datasource ===
1) placeOrder("order-1") — @Transactional() → default (primary) adapter
2) generateInvoice("inv-1") — @TransactionalOn("billing") → billing adapter

Primary DS tables (orders): [ 'order-1' ]
Billing DS tables (invoices): [ 'inv-1' ]

Cross-check isolation — neither DB knows the other's entity:
   primary has `invoices` table? false
   billing has `orders` table? false
```

## How routing works

Every transaction is tracked in the `TransactionContext` (AsyncLocalStorage)
under the composite key `${adapterName}:${instanceName}` — for this
example those are `typeorm:default` and `typeorm:billing`.

`@Transactional({ adapterInstance })` tells the manager which key to
write under when it opens a new transaction, and
`getCurrentEntityManager('billing', fallbackDs)` reads from the same
key. The two adapter instances never collide.

## Key files

- [`src/order.service.ts`](src/order.service.ts) — `@Transactional()`
  on the default adapter instance.
- [`src/billing.service.ts`](src/billing.service.ts) —
  `@TransactionalOn('billing')` for the second DataSource.
- [`src/app.module.ts`](src/app.module.ts) — wires two
  `TypeOrmTransactionalModule.forFeature(...)` registrations side by
  side.
