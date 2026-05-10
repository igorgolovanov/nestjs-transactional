# read-write-separation

Two TypeORM DataSource registrations — `'default'` (master) and
`'replica'` — pointing at master and read-replica Postgres hosts.
Writes go through `@Transactional` on the default DS; reads go
through `@InjectRepository(ArticleRow, 'replica')` and bypass the
transactional adapter entirely.

The framework wiring is minimal: only the master DS is registered
with `TypeOrmTransactionalModule.forRoot`. The replica is a plain
`TypeOrmModule.forRoot` with `synchronize: false`. A misplaced
`@Transactional({ dataSource: 'replica' })` fails fast at bootstrap
because no adapter is registered for that DS — the framework refuses
to silently fall back to autocommit.

## When to use this example

- You have a Postgres read replica and want to offload analytics-
  scale `SELECT` traffic from master without changing your write
  path.
- You want a starting template that pins the read/write boundary
  in the **DI graph** rather than relying on developer discipline:
  the read-side service receives a different `Repository` instance
  than the write-side service, and `@Transactional` simply cannot
  reach the replica.
- You want to see the asymmetric `forRoot` shape — master gets the
  full transactional adapter, replica gets only `TypeOrmModule.forRoot`.

For multiple DataSources both **producing AND consuming** events
see [`multi-datasource-outbox`](../multi-datasource-outbox). For a
business + audit split with cross-DS event delivery see
[`audit-logging`](../audit-logging).

## Replication is out of scope

This example demonstrates the **wiring**, not Postgres replication
itself. The integration test points both DataSources at the same
testcontainers Postgres database so writes immediately become
visible to replica reads — that lets us assert the read path
returns real data without standing up streaming replication
inside the test container.

In production the master and replica DSes connect to different
hosts:

```ts
master:  { host: 'master.db.internal',  database: 'app' }
replica: { host: 'replica.db.internal', database: 'app' }
```

Postgres streaming replication propagates writes from master to
replica with sub-second lag in a healthy cluster. The application
sees that lag as **read-after-write staleness**: a row inserted
through master may not appear via replica for one round trip. The
example does not paper over that — staleness is a property of the
deployment, not the framework.

## Alternative: TypeORM's native `replication` option

TypeORM accepts a `replication: { master, slaves: [...] }` shape
inside a single `DataSource`:

```ts
TypeOrmModule.forRoot({
  type: 'postgres',
  replication: {
    master: { host: 'master.db.internal', ... },
    slaves: [
      { host: 'replica-1.db.internal', ... },
      { host: 'replica-2.db.internal', ... },
    ],
  },
  ...
});
```

TypeORM internally routes write queries to master and read queries
to a slave (round-robin). One DataSource, one schema, one set of
migrations.

When to prefer it over the two-DataSource shape in this example:

- All slaves replicate master via Postgres streaming replication
  (so they share one schema by definition).
- You don't need different DI tokens for read vs write — the wiring
  is entirely inside TypeORM and your services do not know which
  connection a query went to.
- You want load balancing across multiple slaves out of the box.

When the two-DataSource shape (this example) is preferable:

- The "replica" is logically separate (e.g. an analytics replica
  with extra materialised views) — you genuinely want different
  entity registrations or different connection tuning per side.
- You want a misplaced write to throw at DI / type level, not at
  SQL execution level. With native `replication`, `repo.save(...)`
  from any service routes to master implicitly; with two DSes,
  injecting `'replica'` Repository into a writer is a type-system
  smell that surfaces in code review.

Both shapes are valid; pick based on what you want the failure
mode of "wrong target" to look like.

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** testcontainers
  pulls `postgres:16-alpine` on first run (~30 MB).
- For the `pnpm start` visual demo: an externally-running Postgres.
  Defaults `localhost:5432`, master DB `app`, replica DB `app` (same
  DB by default — override `PGREPLICA` to point elsewhere). Other
  env vars: `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGMASTER`.

## Run

```bash
pnpm install                                              # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/read-write-separation test:integration

# Unit tests (none; passWithNoTests for symmetry):
pnpm -C examples/read-write-separation test

# Visual demo with externally-running Postgres:
createdb app                                              # one-shot setup
pnpm -C examples/read-write-separation start
```

## What it shows

1. **Two `TypeOrmModule.forRoot` calls.** `'default'` (master) with
   `synchronize: true`; `'replica'` with `synchronize: false`. Same
   entity registered on both sides — entity metadata is per-DS.
2. **Asymmetric `TypeOrmTransactionalModule.forRoot`.** Only master
   gets `forRoot({ isDefault: true })`. No corresponding call for
   replica — the replica adapter is intentionally absent, so a
   `@Transactional({ dataSource: 'replica' })` cannot resolve.
3. **Two services, two repositories.** `ArticleService` injects
   `@InjectRepository(ArticleRow)` (master); `ArticleQueryService`
   injects `@InjectRepository(ArticleRow, 'replica')`. The DI
   graph encodes the read/write boundary.
4. **`@Transactional` only on the write side.** All write methods
   on `ArticleService` carry the decorator; query methods on
   `ArticleQueryService` do not. The integration test
   `repository binding ...` asserts that the injected repositories
   are different `Repository` instances (master vs replica).
5. **Cross-session isolation.** The test
   `cross-session isolation ...` opens a manual master transaction,
   inserts a row, reads from the replica mid-flight (sees nothing
   because master has not committed yet), then commits and confirms
   the replica sees the row. Demonstrates Postgres READ COMMITTED
   semantics across two independent connection pools — which is the
   default behaviour you get for free with two separate DataSource
   registrations.

## Common pitfalls

- **Forgetting the second argument to `@InjectRepository`.** Without
  the dataSource name, NestJS resolves `Repository<ArticleRow>`
  from the default (master) DS — the read-side service silently
  becomes a master reader and the example's whole separation
  breaks. The first integration test catches this regression.
- **Adding `@Transactional` to query methods.** It does nothing
  useful for replica reads (autocommit single-statement is
  cheaper) and it would route them through the master adapter if
  the default DS is master — the queries would actually hit
  master, defeating the offload. Keep query methods un-decorated.
- **Setting `synchronize: true` on the replica.** A real Postgres
  replica is read-only at the cluster level (`hot_standby` mode)
  and rejects DDL. `synchronize: true` would crash the application
  on bootstrap. The example uses `synchronize: false` on the
  replica DS even though our testcontainers replica is writable —
  it pins the production constraint at the wiring level.
- **Reading from master "for safety".** A common reflex is to
  route reads inside a `@Transactional` write to master to avoid
  read-your-write staleness. This example does not do that
  automatically — if you need read-after-write consistency for a
  specific operation, inject the master repo explicitly into that
  service alongside the replica one and pick per call site.

## Related examples

- [`multi-datasource-basic`](../multi-datasource-basic) — two
  DataSources where each owns its own data (no shared schema).
- [`audit-logging`](../audit-logging) — multi-DS where one DS
  receives written events from the other through the outbox.

## Further reading

- [DD-021 — dataSource name as primary identifier](../../docs/dd/021-datasource-name-primary-identifier.md)
- [DD-023 — multi-datasource isolation](../../docs/dd/023-multi-datasource-isolation.md)
- [TypeORM replication docs](https://typeorm.io/multiple-data-sources#replication)
