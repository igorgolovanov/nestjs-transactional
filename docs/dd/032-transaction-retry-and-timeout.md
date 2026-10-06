# DD-032: Retry a transaction the database asks to retry; deprecate `timeout`

**Context**: under `SERIALIZABLE`, PostgreSQL resolves a conflict
between concurrent transactions by failing one of them with SQLSTATE
40001, and any isolation level can end in a deadlock, 40P01 (MySQL:
1213). The database's contract is that the client runs the failed
transaction again. None of the NestJS reliability modules covers this:
`@nestjs/resilience`'s `@Retry` acts on entrypoints only, and its
`policy.execute` inside a `@Transactional` method would retry a
statement in a transaction that is already aborted. Only the owner of
the transaction can retry it correctly, and that is `@Transactional`.

Separately, `timeout` has been accepted and ignored since the first
release (DD-027), kept as an extension point for a future adapter with
a real transaction budget. No such adapter exists, and an option that
silently does nothing reads like a feature.

**Decision**:

1. **`retry` on `@Transactional`**: `number | { maxAttempts, delay?, retryIf? }`.
   A number is `maxAttempts`, the attempts in total, the first included.
2. **Which errors.** `retryIf` when given. Otherwise the adapter's new
   optional SPI method `isRetryableError(error)`. The TypeORM adapter
   answers yes to PostgreSQL 40001 and 40P01 and to MySQL 1213, reading
   the `QueryFailedError`, its `driverError` and `cause`. An adapter
   without the method retries nothing by default.
3. **Only after a rollback.** An error is retried only if the
   transaction was rolled back for it. An error that committed through
   `noRollbackFor` is never retried.
4. **Only by the owner.** Only a call that starts the transaction
   retries: `REQUIRED` and `NESTED` without an outer transaction,
   `REQUIRES_NEW` always. A call that joins an outer transaction ignores
   `retry`, and says so at debug level. A `REQUIRES_NEW` inside an outer
   transaction retries itself alone.
5. **Each attempt is a new transaction**, with a new handle and new
   hooks. The body runs again from the start. After-commit hooks fire
   once, for the attempt that committed; after-rollback hooks fire for
   each failed one.
6. **Backoff.** `delay` is milliseconds, or a function of the attempt
   number and the error. The default is exponential from 10 ms, capped
   at 1 s, with full jitter, so that the transactions that collided do
   not collide again in step.
7. **`timeout` is deprecated**, with `@deprecated` on the type, and
   removed in the next major. The `readOnly` half of DD-027 stands.

**Rationale**: retrying is the database's documented remedy for these
errors, and the correct place for it is the frame that opened the
transaction. A retry is opt-in because it re-runs the method: code with
side effects outside the database must not be retried blindly.

**Verified by** `packages/core/src/manager/transaction.manager.retry.spec.ts`
(attempt counts, classification, `noRollbackFor`, joins, `REQUIRES_NEW`,
hooks, delays, validation) and
`packages/typeorm/test/integration/retry.integration.spec.ts`. The
integration spec runs two SERIALIZABLE transactions in a write skew on
PostgreSQL. Without `retry`, one fails with 40001. With it, both commit,
and the retried one sees the other's row.
