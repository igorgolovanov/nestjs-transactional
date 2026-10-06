# @nestjs-transactional/drizzle

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Fdrizzle?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/drizzle)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

[Drizzle ORM](https://orm.drizzle.team) adapter for
[`@nestjs-transactional/core`](https://www.npmjs.com/package/@nestjs-transactional/core).

The Drizzle database you already inject starts following
`@Transactional()`: inside a transactional method every call on it runs
on the transaction, outside one it behaves as before. The code that uses
it does not change.

```ts
@Injectable()
export class OrdersService {
  constructor(@Inject(DB) private readonly db: NodePgDatabase<typeof schema>) {}

  @Transactional()
  async place(order: NewOrder) {
    await this.db.insert(orders).values(order);
    await this.db.insert(orderLines).values(order.lines);
    // Both inserts roll back if anything here throws.
  }
}
```

No `tx` parameter threaded through the services, no
`db.transaction(async (tx) => ...)` around the method body.

## Install

```bash
pnpm add @nestjs-transactional/drizzle @nestjs-transactional/core drizzle-orm reflect-metadata
```

## Quick start

Drizzle has no Nest module, so the application provides the database
under a token of its choosing, as it already does. Hand that token to
`TransactionalDrizzleModule`:

```ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalDrizzleModule } from '@nestjs-transactional/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export const DB = Symbol('DB');

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TransactionalDrizzleModule.forRoot({ db: DB }),
  ],
  providers: [
    {
      provide: DB,
      useFactory: () =>
        drizzle({ client: new Pool({ connectionString: process.env.DATABASE_URL }), schema }),
    },
  ],
  exports: [DB],
})
export class DatabaseModule {}
```

`TransactionalModule.forRoot({ isGlobal: true })` has to be there, with
`isGlobal`: that is how this module reaches the core registry.

## How it works

`TransactionalDrizzleModule` patches the instance registered under the
token, nothing else. Every method of its prototype chain (`select`,
`insert`, `update`, `delete`, `execute`, `$count`, `with`,
`transaction`...) gets a wrapper on the instance that picks, at call
time, the `tx` of the transaction active for this database, or the
database itself. The relational `db.query` objects and `$with` are read
the same way. Drizzle's prototypes are not touched, so a `tx`, which
shares them, behaves as Drizzle made it.

The transactions themselves are Drizzle's: `@Transactional` opens one
with `db.transaction()`, passing the isolation level and the read-only
access mode as its config. `PropagationMode.NESTED` is a savepoint,
issued as SQL on the transaction, the same on every driver.

## What to know

- **PostgreSQL only, for now.** node-postgres, postgres-js, PGlite and
  the other PostgreSQL drivers. A MySQL or SQLite database is refused at
  startup. MySQL is planned; SQLite through better-sqlite3 runs its
  transactions synchronously, which `@Transactional` cannot wrap.
- **`db.transaction()` inside `@Transactional` is a savepoint.** The
  call goes to the active `tx`, and a nested Drizzle transaction is a
  savepoint. Its failure rolls back its own work only.
- **Only the registered instance is patched.** A `drizzle()` you create
  by hand outside DI does not follow `@Transactional`. For it, or for the
  `tx` itself, call `getCurrentDrizzleTransaction()`.
- **Method references taken before the module starts** keep pointing at
  the unpatched method: `const insert = db.insert.bind(db)` in a
  constructor that runs first. Call the methods on `db`.
- **`timeout` is not supported**, as with every adapter
  ([DD-032](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/032-transaction-retry-and-timeout.md)).
  `@Transactional({ retry })` is: serialization failures and deadlocks
  (SQLSTATE `40001`, `40P01`) are retried.

## With `@nestjs/outbox` and `@nestjs/workflows`

Their PostgreSQL stores take an executor made from your database,
`fromDrizzle(db)` from `@nestjs/outbox/postgres` or
`@nestjs/workflows/postgres` (the same function, from
`@nestjs/store-kit`). With
[`@nestjs-transactional/outbox`](https://www.npmjs.com/package/@nestjs-transactional/outbox)
and
[`@nestjs-transactional/workflows`](https://www.npmjs.com/package/@nestjs-transactional/workflows),
an outbox message, a workflow start or a signal inside `@Transactional`
commits or rolls back with your rows: the bridges hand the stores the
`tx` of the transaction.

```ts
{
  provide: PostgresWorkflowStore,
  inject: [DB, WorkflowStorage],
  useFactory: (db: Database, storage: WorkflowStorage) =>
    new PostgresWorkflowStore({ executor: fromDrizzle(db) }, storage),
}
```

Pass the registered `db` to `fromDrizzle`. A store's own transactions,
opened through the patched `db.transaction()`, then join an active
`@Transactional` as a savepoint too. The bridges are still what checks
the isolation level a signal needs and waits for the writes before the
commit.

## Helpers

```ts
import {
  getCurrentDrizzleTransaction,
  isInDrizzleTransaction,
} from '@nestjs-transactional/drizzle';

const tx = getCurrentDrizzleTransaction<Database>(); // throws outside a transaction
const txOrDb = getCurrentDrizzleTransaction('default', db); // falls back to db
isInDrizzleTransaction('billing');
```

## Multiple databases

One `forRoot` per database, each with its own `dataSource` name, which
`@Transactional({ dataSource })` uses:

```ts
TransactionalDrizzleModule.forRoot({ db: ORDERS_DB }),
TransactionalDrizzleModule.forRoot({ db: BILLING_DB, dataSource: 'billing' }),
```

The first one registered is the default; `isDefault: true` picks
another. One `drizzle()` instance cannot be two dataSources.

## Async configuration

```ts
TransactionalDrizzleModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    db: DB,
    dataSource: config.get('DB_NAME'),
  }),
});
```

## Compatibility

|                    | Range                                  | Tested in CI                       |
| ------------------ | -------------------------------------- | ---------------------------------- |
| `drizzle-orm`      | `>=0.40.0 <2`, and the 1.0 prereleases | 0.40.1, 0.45, 1.0.0-beta.22        |
| PostgreSQL drivers | any Drizzle supports                   | node-postgres, postgres-js, PGlite |
| NestJS             | `^11 \|\| ^12`                         | 12                                 |
| Node.js            | `>=22.13.0`                            | 22, 24, 26                         |

This package ships **ESM only**, like the rest of the family
([ADR-022](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/022-esm-only-packaging.md)).

## Documentation

- [`drizzle-orders`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/drizzle-orders):
  an order, an outbox message and a workflow in one transaction
- [ADR-025](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/025-drizzle-adapter.md):
  why the instance is patched
- [DD-033](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/033-drizzle-adapter-contract.md):
  the adapter contract
- [`@Transactional` with the NestJS reliability modules](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/guides/reliability-modules.md)

## License

MIT
