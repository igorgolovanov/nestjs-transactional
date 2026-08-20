---
'@nestjs-transactional/typeorm': minor
'@nestjs-transactional/core': patch
'@nestjs-transactional/cqrs': patch
---

`readOnly` is now enforced by the database on Postgres-family dialects.

`TransactionOptions.readOnly` had been declared since the core package
shipped but never honoured — `@ReadOnly()` and
`CqrsTransactionalModule`'s `defaultQueryOptions: { readOnly: true }`
default documented intent while a stray write committed anyway.
`TypeOrmTransactionAdapter` now issues `SET TRANSACTION READ ONLY` as the
transaction's first statement on `postgres`, `cockroachdb` and
`aurora-postgres`, so the write is refused by the database instead.

**It is a hint, and the enforcement is per-dialect.** On every other
dialect the flag remains a silent no-op. That is deliberate on both
counts:

- MySQL and MariaDB are not implementable, not merely unimplemented.
  `SET TRANSACTION` there applies to the *next* transaction and raises
  `ERROR 1568` inside a started one; read-only has to be given as
  `START TRANSACTION READ ONLY`, a moment TypeORM never exposes.
- Silent rather than throwing, because the cqrs module defaults every
  query handler to `readOnly: true` — erroring would break every MySQL
  and SQLite consumer over an option they never set.

So the same code enforces on Postgres and does not on MySQL or SQLite.
That difference is documented in `known-limitations.md` and in the
option's JSDoc; it is worth knowing if you develop against SQLite and
deploy to Postgres. This also matches Spring, where `readOnly` is
explicitly a hint — its real benefit there comes from Hibernate's
`FlushMode.MANUAL`, which has no TypeORM analogue since TypeORM has no
unit of work to skip dirty-checking on.

`readOnly` applies only when the adapter *starts* the transaction: a
`REQUIRED` call joining an existing read-write transaction cannot make it
read-only after the fact. Spring behaves the same way.

**`timeout` remains unimplemented, and deliberately not approximated.**
TypeORM exposes no transaction-level timeout, and Postgres'
`statement_timeout` bounds each statement rather than the transaction —
`timeout: 5000` on a method issuing four queries would allow twenty
seconds, not five. The option stays in the type surface as the extension
point for adapters whose driver has a real transaction budget; Prisma's
`$transaction` accepts exactly that.

Rationale and the alternatives weighed:
[DD-027](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/027-readonly-and-timeout-semantics.md).
