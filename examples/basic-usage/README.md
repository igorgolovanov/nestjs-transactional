# basic-usage

Minimal NestJS application demonstrating `@Transactional()` on a single
service method, backed by TypeORM + SQLite (in-memory via `sql.js`).

## Run

```bash
pnpm install       # from the monorepo root, if not already done
pnpm -C examples/basic-usage start
```

or from this directory:

```bash
pnpm start
```

## What it shows

1. A plain `@Injectable()` `UserService` with two `@Transactional()`
   methods. No custom wiring — the decorator is metadata-only;
   `TransactionalModule.forRoot({ isGlobal: true })` registers
   `TransactionalMethodsBootstrap` which wraps the methods at application
   bootstrap.
2. `createUser('alice', ...)` runs inside a transaction and commits —
   the row is visible in the DB after the call returns.
3. `createUserAndFail('bob', ...)` writes inside the transaction, then
   throws — the manager rolls back, `bob` is NOT persisted.

Expected output:

```
[...] LOG [TransactionalMethodsBootstrap] Wrapped 2 @Transactional methods
=== basic-usage ===
1) createUser("alice") inside @Transactional
   after commit, DB rows: [ 'alice' ]
2) createUserAndFail("bob") — service throws inside @Transactional
   caught: simulated failure after write — should roll back
   after rollback, DB rows: [ 'alice' ]
   expected: bob is NOT in the list — write rolled back
```

## Key files

- [`src/user.service.ts`](src/user.service.ts) — `@Transactional()` on
  regular `@Injectable()` methods; data access through
  `getCurrentEntityManager('default', this.dataSource)` so the repository
  stays inside the active tx.
- [`src/app.module.ts`](src/app.module.ts) — root module wiring
  `TransactionalModule.forRoot({ isGlobal: true })` +
  `TypeOrmTransactionalModule.forFeature({ dataSource })`.
- [`src/main.ts`](src/main.ts) — `NestFactory.createApplicationContext`
  bootstrap; calls the service and logs results.

## Why does `@Transactional` on a service actually work?

`@Transactional()` by itself is metadata-only — the decorator writes to
`reflect-metadata` but does not replace the method. The wrap is
performed at runtime by one of three coordinated mechanisms (see
ADR-005):

- `TransactionalInterceptor` — for controller / resolver / gateway
  request-boundary handlers.
- **`TransactionalMethodsBootstrap`** — used here, for plain
  `@Injectable` providers. Enabled by default by
  `TransactionalModule.forRoot`; opt out with
  `registerMethodsBootstrap: false`.
- `CqrsHandlerWrapper` — for `@CommandHandler` / `@QueryHandler` /
  `@EventsHandler` from `@nestjs/cqrs`.
