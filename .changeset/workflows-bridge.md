---
'@nestjs-transactional/core': major
'@nestjs-transactional/workflows': major
---

New package: `@nestjs-transactional/workflows`, `@Transactional` for `@nestjs/workflows`

`TransactionalWorkflowsModule.forRoot()` makes `WorkflowClient.start()`
and `signal()` join the transaction `@Transactional` opened, with no
`transaction` option: the workflow instance or the signal commits or
rolls back with your rows. That covers `@nestjs/workflows/cqrs` too, so
`@StartOn` and `@SignalOn` on an event published inside a transaction
are atomic with it. On PostgreSQL, a `signal()` inside a transaction
stricter than READ COMMITTED fails with `WorkflowIsolationError` before
anything is written. The contract: DD-031.

core gains `TransactionManager.dialectOf(active)`, which the bridge uses
for that check.
