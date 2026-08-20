---
'@nestjs-transactional/typeorm': minor
---

`PropagationMode.NESTED` now fails with a useful error on drivers that
cannot do savepoints.

`runInSavepoint` used to emit raw `SAVEPOINT` SQL unconditionally. On SQL
Server, SAP HANA, MongoDB, Spanner or Cordova the driver rejects that
statement, so the user got an opaque driver-level error that says nothing
about `NESTED` propagation being the cause — while the
`TransactionAdapter` contract has always specified
`IllegalTransactionStateError` for exactly this case.

The adapter now checks the capability first and throws that error,
naming the driver, the capability TypeORM reported, and the propagation
modes to reach for instead (`REQUIRED` to join the caller's transaction,
`REQUIRES_NEW` for an independent one). The callback is not invoked, so
there is no half-executed nested block.

No dialect allowlist was added — TypeORM reports the capability itself
via `driver.transactionSupport`, which is `'nested'` for the
savepoint-capable drivers (Postgres, MySQL, Oracle, SQLite, CockroachDB,
…) and `'simple'` / `'none'` otherwise. The check is deliberately
permissive when the flag is missing: a TypeORM version that renames or
drops it must not turn every `NESTED` call into a hard failure, since
absence of the signal is not evidence of absent support.

Nothing changes for Postgres, MySQL, SQLite or the other
savepoint-capable drivers — which is every driver this package's tests
and examples run against.

Also adds a contract test suite pinning the TypeORM internals the
transparent-repository patching layer depends on (plain-assignment
`manager` in the `Repository` constructor, delegation through
`this.manager`, `getRepository` on `EntityManager.prototype`, and so on).
Those patches fail silently when an internal shape moves — repositories
quietly run on their own autocommit connection instead of the
transaction — so the suite asserts the substrate directly and names the
file to revisit when an assumption breaks.
