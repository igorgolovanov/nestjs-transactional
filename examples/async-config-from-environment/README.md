# async-config-from-environment

**Tier 5 — Production realism.** Wire the stack (`TypeOrmModule`,
`TransactionalTypeOrmModule` and `@nestjs/outbox`'s `OutboxModule`)
through `forRootAsync` + `ConfigService`,
backed by per-environment `.env` files and Joi validation. The
intent is "this is the boring, correct shape for a real
deployment" rather than "shortest illustration of X".

## When to use this example

- You're standing up a new app and need to know what
  `forRootAsync` looks like for every framework module at once.
- You want a copy-paste skeleton with env-file profiles
  (`development`, `staging`, `production`) and schema validation
  already wired.
- You want to see how operational tunables (the outbox relay's poll
  interval, batch size, concurrency) flow from a single env source
  into the runtime.

## What's different from the sync-config baseline

`basic-typeorm-outbox` calls `forRoot({...})` with hard-coded values.
This example:

1. Uses `ConfigModule.forRoot` with a Joi schema covering every
   key the app reads. Bootstrap fails fast on a malformed
   environment, with all violations reported in one pass
   (`abortEarly: false`).
2. Replaces the configurable `forRoot` calls with `forRootAsync`
   (`TypeOrmModule`, `TransactionalTypeOrmModule`, `OutboxModule`).
   Every factory `inject`s `ConfigService` and reads the validated env
   into typed config blocks. `TransactionalOutboxModule` has nothing to
   tune per environment and stays `forRoot()`.
3. Ships three `.env.*` profiles. `NODE_ENV` selects which file
   loads, so the same binary deploys to dev / staging / prod
   without recompilation.

Domain logic (`AuditService.recordEvent`) and domain tests are
intentionally trivial — the new shape is the configuration
plumbing, not anything in `audit/`.

## Architecture

```
                   process.env (.env.${NODE_ENV})
                              │
                              ▼
                    ┌─────────────────────┐
                    │  Joi validation      │  ← abortEarly: false
                    │  (envValidationSchema)│   reports every error
                    └──────────┬───────────┘     at once
                               │
                               ▼
                       ConfigService
                               │
       ┌───────────────────────┼───────────────────────┐
       │                       │                       │
       ▼                       ▼                       ▼
TypeOrmModule.       TransactionalTypeOrm   OutboxModule.
  forRootAsync         Module.forRootAsync    forRootAsync
       │                       │                       │
       │                       │                       │  relay:
       │                       │                       │  pollInterval,
       │                       │                       │  batchSize,
       │                       │                       │  concurrency
       ▼                       ▼                       ▼
   DataSource              Adapter +              @nestjs/outbox
   (Postgres)              transparent            relay, on a
                           repos                  PostgresOutboxStore
                                                  over the same
                                                  DataSource
```

## Configuration

[`.env.development`](.env.development),
[`.env.staging`](.env.staging),
[`.env.production`](.env.production) carry illustrative values.
[`src/config/config.schema.ts`](src/config/config.schema.ts)
defines the Joi schema and a typed `ValidatedEnv` shape — keep
both in sync as you add keys.

| Key                          | Type   | Constraint            | Why per-env                                     |
| ---------------------------- | ------ | --------------------- | ----------------------------------------------- |
| `PG_HOST`                    | string | required              | dev points at localhost, prod at VPC            |
| `PG_PORT`                    | int    | 1–65535, default 5432 |                                                 |
| `PG_USER`, `PG_PASSWORD`     | string | required              | secrets via vault in prod, not git              |
| `PG_DATABASE`                | string | required              | per-env database isolation                      |
| `OUTBOX_POLLING_INTERVAL_MS` | int    | 50–60000              | dev: 100ms (snappy); prod: 2000ms (DB-friendly) |
| `OUTBOX_BATCH_SIZE`          | int    | 1–1000                | prod batches larger to amortize cost            |
| `OUTBOX_MAX_CONCURRENT`      | int    | 1–100                 | prod runs more handlers in parallel             |
| `HTTP_PORT`                  | int    | 1–65535, default 3000 |                                                 |
| `NODE_ENV`                   | enum   | dev/staging/prod/test | drives `envFilePath` resolution                 |

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** Tests
  pull `postgres:16-alpine` (~30 MB) on first run via
  testcontainers.
- For `pnpm start`: a Postgres 16 instance reachable at the
  host/port in `.env.${NODE_ENV}` and the database created
  beforehand (`createdb async_config_dev`).

## Run

```bash
pnpm install                                                 # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/async-config-from-environment test:integration

# Unit tests (none currently; passWithNoTests for symmetry):
pnpm -C examples/async-config-from-environment test

# Visual demo:
createdb async_config_dev                                    # one-time
NODE_ENV=development pnpm -C examples/async-config-from-environment start
```

## What it shows (verified by integration tests)

1. **`forRootAsync` symmetry across the stack.** Every configurable
   module accepts the same `imports + inject + useFactory` shape.
   `ConfigService` is the single read source for every layer.
2. **Joi schema validates fail-fast.** A missing required key
   (`PG_HOST` omitted) and an out-of-range numeric
   (`OUTBOX_POLLING_INTERVAL_MS=0`) both throw on bootstrap, with
   the error message pointing at the offending key. Tests assert
   on the throw, not on later runtime symptoms.
3. **Per-environment relay tunables flow through.** The
   integration test reads `@nestjs/outbox`'s `OUTBOX_MODULE_OPTIONS`
   for the dev and prod profiles and asserts the resolved
   `relay.pollInterval`, `relay.batchSize` and `relay.concurrency`
   mirror the `.env.*` file values: proof that the async factory
   really plumbs config into the relay, not just the package
   defaults.
4. **Behavior under `forRootAsync` matches the sync baseline.**
   `AuditService.recordEvent` writes the audit row and its outbox
   message in one transaction, and the relay delivers it to the
   `@OnOutboxMessage` handler. The transparent-repository / outbox
   machinery is unaffected by the async wiring path.

## Common pitfalls

- **The env keys keep their names, the options do not.**
  `OUTBOX_POLLING_INTERVAL_MS`, `OUTBOX_BATCH_SIZE` and
  `OUTBOX_MAX_CONCURRENT` map onto `@nestjs/outbox`'s
  `relay.pollInterval`, `relay.batchSize` and `relay.concurrency`.
  The env names stayed so a deployment's configuration did not have
  to change with the upgrade.
- **The store is a provider, not a factory result.** `OutboxModule`'s
  async factory returns options only. The `PostgresOutboxStore` is an
  ordinary provider that registers itself with `OutboxStorage`, so it
  sits in `providers` next to the services; see
  [`src/app.module.ts`](src/app.module.ts).
- **dotenv refuses to overwrite an existing `process.env` key.**
  Two consequences: (1) tests that load different `.env` files
  sequentially in the same process get cross-contamination — an
  earlier file's values mask later files' values. The integration
  test snapshots and restores `process.env` between cases. (2) In
  production, exported shell variables override `.env` files —
  which is _intended_, since secrets-manager-injected env should
  win over a committed file. Don't rely on `.env` to "reset" a
  variable that has already been set in the deployment
  environment.
- **`TransactionalModule.forRootAsync` does not accept a `dataSource` field.**
  The per-DS adapter token isn't registered for the async path
  for the same reason as above. The `AdapterRegistry`-routed
  access — `@Transactional({ dataSource })`,
  `getCurrentEntityManager(dataSource)` — works regardless,
  because the registry is populated as a side effect of the
  factory.
- **Forgetting `imports: [ConfigModule]` on a `forRootAsync` call.**
  `ConfigModule.forRoot({ isGlobal: true })` makes `ConfigService`
  globally available for plain `@Inject(ConfigService)` usage,
  but `forRootAsync`'s `useFactory` runs in the dynamic module's
  own scope — its `inject` array still requires the importing
  module to have `ConfigModule` visible. The example always
  passes `imports: [ConfigModule]` next to `inject:
[ConfigService]` for clarity.
- **Treating `.env.production` as the source of truth for secrets.**
  The committed `.env.production` here carries illustrative
  values (`replace-me-via-secret-manager`) — a real deployment
  fetches secrets at boot through Vault / AWS Secrets Manager /
  Doppler / Kubernetes secrets. Joi validation enforces _shape_,
  not authenticity.
- **`ConfigModule.forRoot` is async.** Its returned Promise is what
  rejects on a schema violation, so a test must await module
  compilation: `await expect(Test.createTestingModule(...).compile())
.rejects.toThrow(...)`. A synchronous `expect(() => ...).toThrow()`
  would pass while catching nothing.

## Related examples

- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — the sync
  baseline. Compare `app.module.ts` side-by-side to see what
  `forRootAsync` adds.
- [`e-commerce-orders`](../e-commerce-orders) — Tier 5 flagship.
  Uses sync config to keep the saga the focus; in production
  you'd swap each `forRoot` for the `forRootAsync` shape from
  this example.

## Further reading

- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
- [ADR-023 — delivery through `@nestjs/outbox`](../../docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
- `@nestjs/config` upstream docs:
  https://docs.nestjs.com/techniques/configuration
