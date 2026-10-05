# audit-logging

Two physical Postgres databases — **business** and **audit** —
demonstrating cross-DataSource audit logging without distributed
transactions. Business operations commit atomically in one DS; the
audit consumer writes to the other DS after `@nestjs/outbox`'s relay
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
  DS with the outbox, one DS with only the transactional adapter,
  no outbox tables on the sink side. It is also the shape the outbox
  supports: it lives in exactly one DataSource (ADR-023).

For a saga across multiple steps within ONE DataSource see
[`saga-pattern`](../saga-pattern).

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
is not yet written. If the audit DS is unreachable when the relay
delivers, the handler's transaction fails, the message stays in the
outbox, and the relay retries it with backoff until the audit DS is
back. The audit log catches up; it does not lose data (at-least-once +
idempotency).

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
   │  │ nest_outbox.messages / .inbox   │     │
   │  └─────────────────────────────────┘     │
   │              │                           │
   │              │ @nestjs/outbox relay      │
   └──────────────┼───────────────────────────┘
                  │
                  ▼ AuditHandler.log (cross-DS hop)
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

1. **Asymmetric wiring.** The business DS gets the outbox:
   `@nestjs/outbox`'s `OutboxModule` with a `PostgresOutboxStore` on the
   business DataSource, plus `TransactionalOutboxModule`. The audit DS
   gets only `TransactionalTypeOrmModule.forRoot({ dataSource: 'audit' })`;
   no outbox tables, no relay. The audit DB is a sink.
2. **Atomicity in the business DS.** Inside
   `AccountService.deposit/withdraw`, three writes commit together
   in the business DS: the `accounts.balance` update, the
   `account_operations` insert, and the outbox message. A throw rolls
   ALL of them back — the integration test
   `business rollback: overdraw throws...` pins this.
3. **Cross-DS isolation (DD-023).** A business-DS rollback never
   leaks into the audit DS — there was nothing to leak: the audit
   handler had not yet been invoked. The audit DS sees only
   committed business operations; abandoned ones are invisible.
4. **`@OnOutboxMessage` + `@Transactional({ dataSource: 'audit' })` on
   one method.** The audit handler runs in a fresh **audit-DS**
   transaction. `@nestjs/outbox` calls the method through the instance
   at delivery time, so it gets the transactional version, and the
   framework tracks per-DS `AsyncLocalStorage` (DD-023), so it opens in
   the right context.
5. **Idempotent audit consumer, in two layers.** The handler's inbox
   skips a message it already completed, but it lives in the business
   DB and cannot commit with the audit row. `AuditLogRow.operationId`,
   the primary key, closes that gap: a delivery that wrote the row but
   crashed before its inbox record surfaces on the retry as
   `unique_violation` and is skipped. The audit log gains exactly one
   row per business operation however many times the message arrives.
6. **Audit DS outage does not block business.** The integration
   test `audit DS down...` destroys the audit DS connection pool,
   runs a deposit (which succeeds), sees the relay keep the message
   with one failed attempt, restores the audit DS, and confirms the
   retry writes the audit row.

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
  any ambient business-DS transaction (the relay's context has none,
  but a chained-handler scenario could surprise you).
- **Treating the outbox as the audit trail.** `@nestjs/outbox` removes
  a message once it is delivered; it keeps only dead letters. The audit
  trail is `audit_log` in the audit DB, with the retention your
  compliance regime requires.

## Related examples

- [`saga-pattern`](../saga-pattern) — multi-step coordination
  through the outbox within a single DataSource.
- [`externalization-with-fallback`](../externalization-with-fallback) —
  the consumer-side inbox/dedup pattern in detail.

## Further reading

- [ADR-023 — delivery through `@nestjs/outbox`, one outbox DataSource](../../docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
- [DD-023 — independent transaction contexts per dataSource](../../docs/dd/023-independent-tx-contexts-per-ds.md)
- [ADR-018 — multi-adapter architecture](../../docs/adr/018-multi-adapter-architecture.md)
