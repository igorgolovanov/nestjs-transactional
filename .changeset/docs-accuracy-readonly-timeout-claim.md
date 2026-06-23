---
'@nestjs-transactional/core': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/outbox-typeorm': patch
---

Documentation accuracy pass — three claims corrected. No runtime
behaviour changes; JSDoc, README and guide text only.

**`readOnly` / `timeout` are documented as unimplemented.** Both
options on `TransactionOptions` are accepted by the core and handed to
the adapter, but the shipped `TypeOrmTransactionAdapter` forwards only
`isolation` — so both are no-ops today. Their JSDoc previously read as
a working feature ("Adapters may ... issue `SET TRANSACTION READ ONLY`",
"exceeding this triggers a rollback"), which made `@ReadOnly()` and
`CqrsTransactionalModule`'s `defaultQueryOptions: { readOnly: true }`
default look like write protection. The options keep their place in the
type surface — they are the intended extension point, and the
`TransactionAdapter` contract permits adapters to honour them — but the
JSDoc on `TransactionOptions.readOnly`, `TransactionOptions.timeout`,
`@ReadOnly`, and the cqrs module now say plainly that nothing enforces
them yet, and point at `docs/known-limitations.md`, which gained a
dedicated entry.

**`CqrsTransactionalModule`'s `@example` no longer violates
convention #6.** The shipped example imported `@nestjs/cqrs`'s
`CqrsModule` alongside `CqrsTransactionalModule.forRoot()` — the exact
double-import that shadows the `EventPublisher` override and silently
routes aggregate events around the dispatcher. It was the only place in
the repository still showing that pattern, and it shipped in the
`.d.ts`. The example also referenced a non-existent
`TypeOrmTransactionalModule.forFeature(...)`; it now uses `forRoot`.

**The `EventPublicationRepository` concurrency contract is stated
correctly, and on the right method.** Docs and the SPI's own JSDoc
required production `findReadyForProcessing` implementations to use
`SELECT ... FOR UPDATE SKIP LOCKED` "to be safe against concurrent
workers". No shipped implementation does — row locking was dropped
before release, because a pessimistic lock has to be held by a
transaction spanning the listener invocation, which is unsafe for
long-running listeners. The in-memory reference implementation does not
lock either, and the interface contradicted itself: `tryClaim`'s JSDoc
also claimed responsibility for preventing double-processing.

`tryClaim` is the method that actually carries the guarantee, and its
JSDoc now says so normatively: the status check and the transition MUST
be one indivisible operation (conditional `UPDATE` with affected-row
count, `findOneAndUpdate` with the status in the filter, or equivalent
compare-and-set), because a read-then-write claim lets two workers both
observe `PUBLISHED` and both dispatch. `findReadyForProcessing` is
documented as deliberately non-exclusive — overlapping results are
allowed, and a losing claim costs a wasted read rather than a duplicate
dispatch. Row locking remains permitted as an optimisation but may not
be relied on for correctness.

This matters to anyone implementing the SPI for another datastore
(`outbox-prisma`, `outbox-mongodb`): the previous wording pointed the
obligation at the wrong method. Rationale and alternatives:
[DD-025](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/025-claim-atomicity-obligation.md).
ADR-007's SPI-contract appendix is corrected in place with an amendment
note; its decision (the `outbox` / `outbox-typeorm` package split) is
unchanged. No behaviour changed in either shipped backend — both
already matched the corrected contract.
