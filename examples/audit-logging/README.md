# audit-logging

Two physical Postgres databases — **business** and **audit** —
demonstrating cross-DataSource audit logging without distributed
transactions. Business operations commit atomically in one DS; the
audit consumer writes to the other DS after the outbox worker
delivers the event. Consistency between the two DBs is reached
through at-least-once delivery + an idempotency gate on the
audit-row primary key (DD-023).

## When to use this example

- Your audit trail must survive a business-DB restore-from-backup.
  Co-locating the audit log with the business data couples their
  lifecycles and a recovery rolls them back together.
- Your audit consumer is allowed to be eventually consistent —
  audit rows appear within milliseconds under load, but a brief
  audit-DB outage does not block business operations.
- You want a template for the **asymmetric multi-DS shape**: one
  DS with the full outbox stack, one DS with only the transactional
  adapter, no outbox tables on the sink side.

For a saga across multiple steps within ONE DataSource see
[`saga-pattern`](../saga-pattern). For multiple DataSources both
producing AND consuming events see
[`multi-datasource-outbox`](../multi-datasource-outbox).

## Why not co-locate the audit table in the business DB?

A common alternative: keep `audit_log` in the same DB as
`accounts`, write both rows in the same `@Transactional`. That
gives you stronger atomicity (audit and balance can never
disagree) but trades away independence:

- A bug that wipes the business schema also wipes audit.
- A business-DB restore loses audit rows since the backup point.
- Audit-table growth competes with business-table I/O on the
  same disk / same WAL.
- Compliance teams typically want a separate retention policy
  on the audit DB (years) than the business DB (operational).

The cross-DS pattern in this example accepts a millisecond-scale
window where the business operation is committed but the audit row
is not yet written. If the audit DS is unreachable when the worker
runs, the publication moves to `FAILED` and is retried by an
operator. The audit log catches up; it does not lose data
(at-least-once + idempotency).

When the stronger atomicity is required (e.g. financial regulation
forbids any window between business-write and audit-write), keep
both writes in one transaction in one DB and accept the coupling.

## Architecture

```
   ┌──────────────────────────────────────────┐
   │  Business DS (Postgres "business")       │
   │  ┌────────────┐   ┌────────────────┐     │
   │  │ accounts   │   │ account_       │     │
   │  │            │   │   operations   │     │
   │  └────────────┘   └────────────────┘     │
   │  ┌─────────────────────────────────┐     │
   │  │ event_publication               │     │
   │  └─────────────────────────────────┘     │
   │              │                           │
   │              │ worker (poll)             │
   └──────────────┼───────────────────────────┘
                  │
                  ▼ AuditHandler.handle (cross-DS hop)
   ┌──────────────────────────────────────────┐
   │  Audit DS (Postgres "audit_db")          │
   │  ┌─────────────────────────────────┐     │
   │  │ audit_log                       │     │
   │  └─────────────────────────────────┘     │
   │              (no outbox tables — sink)   │
   └──────────────────────────────────────────┘
```

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** testcontainers
  pulls `postgres:16-alpine` on first run (~30 MB).
- For the `pnpm start` visual demo: two existing Postgres databases
  on `localhost:5432` — defaults `business` and `audit`. Override
  via env vars (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`,
  `PGBUSINESS`, `PGAUDIT`).

## Run

```bash
pnpm install                                       # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/audit-logging test:integration

# Unit tests (none; passWithNoTests for symmetry):
pnpm -C examples/audit-logging test

# Visual demo with externally-running Postgres:
createdb business && createdb audit                # one-shot setup
pnpm -C examples/audit-logging start
```

## What it shows

1. **Asymmetric multi-`forRoot` wiring.** Business DS gets the full
   outbox stack (`OutboxTypeOrmModule.forRoot` +
   `OutboxModule.forRoot` + worker via `OutboxProcessingModule` +
   `forFeature` registration). Audit DS gets only
   `TypeOrmTransactionalModule.forRoot({ dataSource: 'audit' })` —
   no `event_publication` table, no worker. The audit DB is a sink.
2. **Single-unit atomicity per DS (DD-019).** Inside
   `AccountService.deposit/withdraw`, three writes commit together
   in the business DS: the `accounts.balance` update, the
   `account_operations` insert, and the outbox row. A throw rolls
   ALL of them back — the integration test
   `business rollback: overdraw throws...` pins this.
3. **Cross-DS isolation (DD-023).** A business-DS rollback never
   leaks into the audit DS — there was nothing to leak: the audit
   handler had not yet been invoked. The audit DS sees only
   committed business operations; abandoned ones are invisible.
4. **`@Transactional({ dataSource: 'audit' })` on the consumer.**
   The audit handler runs in a fresh **audit-DS** transaction. The
   worker that invoked it ran on the business DS — the framework
   tracks per-DS `AsyncLocalStorage` (DD-023) so the consumer's
   own `@Transactional` opens in the right context.
5. **Idempotent audit consumer.** `AuditLogRow.operationId` is the
   primary key. Retried delivery surfaces as `unique_violation`
   and is skipped — the audit log gains exactly one row per business
   operation regardless of how many times the publication is
   delivered.
6. **Audit DS outage does not block business.** The integration
   test `audit DS down → publication stays PUBLISHED...` destroys
   the audit DS connection pool, runs a deposit (which succeeds),
   waits for the worker to mark the publication FAILED, restores
   the audit DS, and confirms the audit row eventually catches up.

## Common pitfalls

- **Forgetting `@InjectRepository(AuditLogRow, 'audit')`.** Without
  the second argument, TypeORM resolves `AuditLogRow` against the
  default (business) DataSource, where its table does not exist.
  Postgres throws `relation "audit_log" does not exist` on first
  use.
- **Forgetting `@Transactional({ dataSource: 'audit' })` on the
  handler.** Without it, `@Transactional()` defaults to the
  business DS. The audit-DS write goes through autocommit, and the
  audit-DS read-your-write semantics inside the handler are lost.
  More subtly, the handler's `@Transactional` would attempt to join
  any ambient business-DS transaction (worker context typically has
  none, but a chained-handler scenario could surprise you).
- **Tying audit retention to the outbox archive.** The outbox
  archive lives in the business DS — it follows business-DS
  retention. If your compliance regime requires keeping the audit
  trail for years, the audit DB's `audit_log` retention is what
  matters; the outbox archive is operational data.
- **`CqrsModule` double-import.** Do NOT import `@nestjs/cqrs`'s
  `CqrsModule` directly alongside `CqrsTransactionalModule.forRoot()`.
  See [`docs/status/conventions.md`](../../docs/status/conventions.md) #6.

## Related examples

- [`saga-pattern`](../saga-pattern) — multi-step coordination
  through the outbox within a single DataSource.
- [`multi-datasource-outbox`](../multi-datasource-outbox) —
  symmetric multi-DS where both DSes produce events.
- [`externalization-with-fallback`](../externalization-with-fallback) —
  the consumer-side inbox/dedup pattern in detail.

## Further reading

- [DD-019 — single-unit atomicity invariant](../../docs/dd/019-single-unit-atomicity.md)
- [DD-023 — multi-datasource isolation](../../docs/dd/023-multi-datasource-isolation.md)
- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter.md)
