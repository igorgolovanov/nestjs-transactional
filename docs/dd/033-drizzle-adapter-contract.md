# DD-033: The Drizzle adapter contract

**Context**: ADR-025 adds `@nestjs-transactional/drizzle`, which makes
the application's own `drizzle()` instance follow `@Transactional` by
patching it. This records what is patched, how the adapter maps the
transaction options, and what is supported.

**Decision**:

1. **Registration.** `TransactionalDrizzleModule.forRoot({ db, dataSource?, isDefault? })`
   injects the database by token, checks it, patches it, and registers a
   `DrizzleTransactionAdapter` as adapter `'drizzle'`, instance
   `dataSource` (default `'default'`). `forRootAsync` resolves the
   options first and looks the database up in `onModuleInit`. One
   instance cannot be registered under two dataSource names.
2. **The patched surface.** On the instance only:
   - every function on its prototype chain except `constructor` gets an
     own-property wrapper. Drizzle's prototypes are not touched, so a
     `tx`, which shares them, is unaffected;
   - `query`, 1.0's `_query` and `$with`, data properties of the
     instance, become getters.
   Each picks, at call time, the `tx` of the transaction active under
   the context key `drizzle:<dataSource>`, or the database itself. The
   methods from before the patch are kept on the instance under a
   registered symbol.
3. **Transactions.** `runInTransaction` calls the original
   `db.transaction(work, config)`: `isolationLevel` is the option in
   Drizzle's lower-case spelling, and `readOnly` is
   `accessMode: 'read only'`. The original method keeps `REQUIRES_NEW`
   a new transaction inside an outer one.
4. **Savepoints.** `runInSavepoint` issues `SAVEPOINT`, `RELEASE
   SAVEPOINT` and `ROLLBACK TO SAVEPOINT` on the parent `tx` with
   generated names, and passes the parent handle on, as the TypeORM
   adapter does. It does not use a nested `tx.transaction()`, whose
   statements differ by driver. A `db.transaction()` the application
   calls inside `@Transactional` is Drizzle's own nested transaction,
   which is also a savepoint.
5. **SPI.** `nativeTransaction` is the `tx`, which `fromDrizzle()`'s
   `wrapTransaction` accepts (`Pg*Transaction` entity kind). `dialect`
   is `'postgres'`, read from the `Pg*Database` entity kind; any other
   database is refused when the module starts. `isRetryableError` is
   true for SQLSTATE `40001` and `40P01` on the error or down its
   `cause` chain, since Drizzle 0.44 wraps driver errors in
   `DrizzleQueryError`. `timeout` is not mapped (DD-032).
6. **Supported versions.** Peer `drizzle-orm >=0.40.0 <2 || >=1.0.0-0`.
   0.40 is the oldest line whose `transaction()` takes `accessMode` and
   that has the instance shape the contract spec pins. 1.0 renames the
   classes (`PgAsyncDatabase`, `PgAsyncTransaction`) and builds
   `db.query` from `relations`; the patch is name-agnostic and covers
   both.

**Rationale**: patching on the instance keeps the change local to the
object the application chose to manage, and wrapping every prototype
method rather than a list means a new query builder in a later Drizzle
follows the transaction without a release of ours. Plain SQL savepoints
give one behaviour across drivers.

**Verified by** the unit suites on PGlite
(`packages/drizzle/src/**/*.spec.ts`), the contract spec
`packages/drizzle/test/unit/drizzle-internals.contract.spec.ts`, and the
integration suites on PostgreSQL through node-postgres and postgres-js
(`packages/drizzle/test/integration`): visibility to other connections,
`REQUIRES_NEW`, `NESTED`, read-only, retry on a write skew, and the
outbox, workflows and cqrs bridges on a Drizzle database. CI's
`drizzle-matrix` job runs them on 0.40.1 and 1.0.0-beta.22, next to 0.45
from the lockfile.
