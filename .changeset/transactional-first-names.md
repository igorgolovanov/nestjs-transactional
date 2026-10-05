---
'@nestjs-transactional/typeorm': major
'@nestjs-transactional/cqrs': major
---

Public names lead with `Transactional` (DD-030)

`TypeOrmTransactionalModule` becomes `TransactionalTypeOrmModule`,
`CqrsTransactionalModule` becomes `TransactionalCqrsModule`, and the same
for their options types, `CqrsTransactionalBootstrap`, and
`CQRS_TRANSACTIONAL_OPTIONS`, now `TRANSACTIONAL_CQRS_OPTIONS`. It
matches `TransactionalModule`, `TransactionalOutboxModule`, and the way
NestJS names its own integrations, such as `WorkflowsCqrsModule`.

The old names remain as deprecated aliases of the same classes and
values, and are removed in the next major. One edge: the string value
of the options token changes, so code that injected the literal
`'CQRS_TRANSACTIONAL_OPTIONS'` instead of the constant must switch to
the constant.
