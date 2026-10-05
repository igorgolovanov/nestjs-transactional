---
'@nestjs-transactional/core': major
'@nestjs-transactional/typeorm': major
---

`@Transactional({ retry })` retries serialization failures and deadlocks; `timeout` is deprecated

`retry` runs the transaction again, from the start, when the database
rolls it back with an error it expects the client to retry. The TypeORM
adapter recognises PostgreSQL's 40001 and 40P01 and MySQL's 1213, and
`retryIf` overrides that. Only the call that starts the transaction
retries; each attempt is a fresh transaction with fresh hooks; an error
that committed through `noRollbackFor` is never retried. Adapters gain
an optional `isRetryableError(error)` SPI method. Details: DD-032.

`timeout`, which no adapter here ever implemented, is deprecated and
goes in the next major.
