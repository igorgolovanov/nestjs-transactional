# DD-027: `readOnly` is honoured where the dialect allows it; `timeout` stays an unimplemented extension point

**Context**: `TransactionOptions` has carried `readOnly` and `timeout`
since the core package shipped, with JSDoc that read like working
features. Neither was ever implemented — the only shipped adapter
forwards `isolation` and drops both. The post-alpha assessment recorded
this as item A1; a stopgap already corrected the JSDoc and added a
[known-limitations](../known-limitations.md) entry, leaving the
implement-or-deprecate decision open. `@ReadOnly()` and
`CqrsTransactionalModule`'s `defaultQueryOptions: { readOnly: true }`
default both ride on `readOnly`, so whatever is decided reaches every
query handler in every consuming application.

What the research turned up matters more than the options list:

- **Spring's `readOnly` is explicitly a hint, not enforcement.** The
  real benefit in Spring comes from Hibernate's `FlushMode.MANUAL`,
  which skips dirty-checking on a read-only unit of work. TypeORM has no
  equivalent — no unit of work, no dirty checking — so there is nothing
  analogous to optimise. Our "declared but not enforced" state was
  therefore already at parity; only the JSDoc oversold it.
- **TypeORM exposes no hook for either option.** `DataSource.transaction`
  takes an isolation level and a runner, nothing else;
  `QueryRunner.startTransaction` likewise. Any implementation has to
  issue dialect-specific SQL inside the transaction the runner is
  already in.
- **On Postgres-family dialects that works.** `SET TRANSACTION READ ONLY`
  is valid after `BEGIN` provided it precedes the first query or
  data-modification statement — which is exactly where the adapter sits
  when the runner is invoked. CockroachDB documents the same rule.
- **On MySQL it is not merely unsupported, it errors.** MySQL's
  `SET TRANSACTION` without `GLOBAL`/`SESSION` applies to the *next*
  transaction and "is not permitted within transactions": issuing it
  after `START TRANSACTION` raises `ERROR 1568 (25001) Transaction
  characteristics can't be changed while a transaction is in progress`.
  Read-only there must be set as `START TRANSACTION READ ONLY`, and
  TypeORM never surrenders that moment. So there is no MySQL
  implementation to write, only a failure to avoid.
- **`statement_timeout` is per-statement, not per-transaction.**
  Postgres' `SET LOCAL statement_timeout` bounds each statement inside
  the transaction; it never bounds the transaction as a whole, which is
  what the name `timeout` and Spring's transaction-level budget both
  promise. MySQL's `max_execution_time` is narrower still (SELECT only).

**Alternatives considered**:

- **Implement `readOnly` everywhere, erroring on dialects that cannot
  honour it** (the shape [DD-026's sibling A7 work](../roadmap/improvement-plan.md)
  used for savepoints). Rejected: the cqrs module defaults every query
  handler to `readOnly: true`, so this would break every MySQL and
  SQLite consumer at once, on code they never wrote.
- **Remove `readOnly` from the type surface.** Rejected: it diverges
  from Spring for no gain, throws away the natural extension point for
  read-replica routing (which this repo already demonstrates in the
  `read-write-separation` example), and would break `@ReadOnly()` and the
  cqrs default.
- **Implement `timeout` as `SET LOCAL statement_timeout`.** Rejected: it
  would deliver per-statement semantics under a name that promises a
  transaction budget. A wrong meaning silently attached to a familiar
  name is worse than a documented gap — a user setting
  `timeout: 5000` on a method making four queries would get up to 20
  seconds, not five.
- **Implement `timeout` as a wall-clock deadline in the manager.**
  Rejected: nothing can interrupt a statement already in flight, so the
  deadline would be observed only at `await` boundaries. That detects an
  overrun rather than enforcing a bound, and the rollback still queues
  behind the running statement.
- **Remove `timeout` from the type surface.** Rejected on evidence:
  Prisma's `$transaction` accepts a real transaction-level `timeout`, so
  a future Prisma adapter can implement the option correctly and
  natively. Removing it now would only mean reintroducing it later as a
  breaking change.

**Decision**:

- **`readOnly` is a hint that adapters honour where the dialect allows,
  matching Spring's semantics.** The TypeORM adapter issues
  `SET TRANSACTION READ ONLY` as the first statement of the transaction
  on Postgres-family dialects (`postgres`, `cockroachdb`,
  `aurora-postgres`), giving real database-level enforcement there. On
  every other dialect it is a silent no-op — deliberately silent,
  because the alternative breaks consumers who never opted in.
- **The dialect list is an explicit allowlist and is documented as such.**
  Unlike the savepoint check in the same adapter, TypeORM publishes no
  capability flag for transaction access mode, so there is nothing to
  read. The list needs review when a driver is added; a comment in the
  adapter says so.
- **`readOnly` only applies when the adapter starts the transaction.** A
  `REQUIRED` call joining an existing read-write transaction cannot make
  it read-only after the fact. Spring behaves the same way.
- **`timeout` stays declared and unimplemented, documented per adapter.**
  It remains in `TransactionOptions` as the extension point a Prisma
  adapter will implement natively. The TypeORM adapter does not
  approximate it.

**Consequences**:

- `@ReadOnly()` and the cqrs `defaultQueryOptions` default become real
  protection on Postgres — a stray write in a query handler now fails at
  the database instead of committing.
- **The same code enforces on Postgres and does not on MySQL or SQLite.**
  This is the cost of the decision, and it is the reason the docs state
  the per-dialect behaviour explicitly rather than describing `readOnly`
  as "enforced". A team developing against SQLite and deploying to
  Postgres will meet the constraint for the first time in production;
  the mitigation is documentation, plus the fact that failing there is
  strictly better than the write silently landing.
- Read-replica routing remains available later as a second, orthogonal
  meaning for the same flag, without another API addition.
- `timeout` continues to do nothing on TypeORM. That is now a recorded
  decision with a reason rather than an unexplained gap, and
  `known-limitations.md` says so.

**See also**:

- [Improvement plan, item A1](../roadmap/improvement-plan.md)
- [Known limitations](../known-limitations.md)
- [DD-005 — multi-DataSource as a first-class feature](005-multi-datasource-first-class.md)
- [Spring `@Transactional` reference](https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html)
- [MySQL `SET TRANSACTION` scope rules](https://dev.mysql.com/doc/refman/8.4/en/set-transaction.html)
- [PostgreSQL `SET TRANSACTION`](https://www.postgresql.org/docs/17/sql-set-transaction.html)
