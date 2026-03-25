# basic-transactional

Foundational `@Transactional()` example showcasing **Phase 14.20 transparent
repositories** — `@InjectRepository(UserEntity)` works out of the box,
no `getCurrentEntityManager()` boilerplate.

Backed by TypeORM + SQLite in-memory (via `sql.js`); no Docker required.

## When to use this example

- You are starting from scratch and want the smallest possible illustration
  of declarative transactions in NestJS.
- You want to see how `@InjectRepository` cooperates with `@Transactional()`
  with zero glue code (Phase 14.20 selling point).
- You want a regression-friendly template for your own service unit tests
  that exercise commit + rollback paths.

For multi-DataSource setups see `multi-datasource` (Phase 14.8b);
for outbox-backed event delivery see `basic-outbox` and `basic-typeorm-outbox`.

## Run

```bash
pnpm install                                      # from monorepo root
pnpm -C examples/basic-transactional start        # visual demo (main.ts)
pnpm -C examples/basic-transactional test         # jest regression tests
```

Or from this directory: `pnpm start` / `pnpm test`.

## What it shows

1. `UserService` injects `Repository<UserEntity>` via `@InjectRepository`
   from `@nestjs/typeorm`. The repository is a regular TypeORM `Repository`
   — but its `manager` getter is patched at module-load by
   `@nestjs-transactional/typeorm` to consult the active `@Transactional()`
   scope. No `getCurrentEntityManager()` calls, no `EntityManager` plumbing.
2. `createUser('alice', ...)` runs inside a transaction and commits — the
   row is visible after the call returns.
3. `createUserAndFail('bob', ...)` writes inside the transaction, then
   throws — the manager rolls back, `bob` is NOT persisted.

Expected `pnpm start` output:

```
[...] LOG [TransactionalMethodsBootstrap] Wrapped 2 @Transactional methods
=== basic-transactional ===
1) createUser("alice") inside @Transactional
   after commit, DB rows: [ 'alice' ]
2) createUserAndFail("bob") — service throws inside @Transactional
   caught: simulated failure after write — should roll back
   after rollback, DB rows: [ 'alice' ]
   expected: bob is NOT in the list — write rolled back
```

## Key files

- [`src/user.service.ts`](src/user.service.ts) — `@Transactional()` on a
  regular `@Injectable()` method; data access through
  `@InjectRepository(UserEntity)`. **No `getCurrentEntityManager()` call.**
- [`src/app.module.ts`](src/app.module.ts) — `TypeOrmModule.forRoot/forFeature`
  + `TransactionalModule.forRoot` + `TypeOrmTransactionalModule.forRoot()`.
- [`src/main.ts`](src/main.ts) — `NestFactory.createApplicationContext`
  bootstrap; calls the service and logs results.
- [`test/user.service.spec.ts`](test/user.service.spec.ts) — jest tests
  for commit + rollback + isolation between sibling transactions.

## Why does `@Transactional` on a service actually work?

`@Transactional()` by itself is metadata-only — the decorator writes to
`reflect-metadata` but does not replace the method. The wrap is performed
at runtime by one of three coordinated mechanisms (see ADR-005):

- `TransactionalInterceptor` — for controller / resolver / gateway
  request-boundary handlers.
- **`TransactionalMethodsBootstrap`** — used here, for plain `@Injectable`
  providers. Enabled by default by `TransactionalModule.forRoot`; opt out
  with `registerMethodsBootstrap: false`.
- `CqrsHandlerWrapper` — for `@CommandHandler` / `@QueryHandler` /
  `@EventsHandler` from `@nestjs/cqrs`.

## Common pitfalls

- **`@InjectEntityManager() em.save(Entity, ...)` direct call is NOT
  transactional.** Phase 14.20 patches `EntityManager.prototype.getRepository`,
  not `EntityManager.prototype.save`. Use the Repository pattern shown here,
  or fall back to `getCurrentEntityManager()` for a manual escape hatch.
- **`BaseEntity` static methods (`User.save(...)`) are NOT supported.**
  `BaseEntity.useDataSource(...)` stores a captured DataSource that bypasses
  the patches. Use the Repository pattern.
- **Do not import `CqrsModule` directly alongside
  `CqrsTransactionalModule.forRoot()`** — the latter overrides the
  `EventPublisher` DI token, and a duplicate import shadows the override.
  (Not relevant in this example; mentioned for the cqrs-aware sibling
  examples.)

## Related examples

- [`basic-outbox`](../basic-outbox) — same shape but with the outbox stack
  for durable event delivery (no TypeORM).
- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — full Postgres + outbox
  end-to-end via testcontainers.
- [`basic-cqrs`](../basic-cqrs) — `@CommandHandler` + phase-aware in-memory
  listeners.

## Further reading

- [ADR-005 — method wrapping strategy](../../docs/adr/005-method-wrapping-strategy.md)
- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
  (Phase 14.20 addendum documents the transparent-repository design)
