# @nestjs-transactional/workflows

## 3.0.0

### Major Changes

- [#94](https://github.com/igorgolovanov/nestjs-transactional/pull/94) [`127b2a9`](https://github.com/igorgolovanov/nestjs-transactional/commit/127b2a9bc408232a8888b9cea4f3ed31b4ede3f3) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - New package: `@nestjs-transactional/workflows`, `@Transactional` for `@nestjs/workflows`
  
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

### Patch Changes

- Updated dependencies [[`6209829`](https://github.com/igorgolovanov/nestjs-transactional/commit/6209829f32cf2055519996f33afad4dc11159d3e), [`92bf389`](https://github.com/igorgolovanov/nestjs-transactional/commit/92bf389fe4e2ccf4a1aefa7941f05183bf5afd1b), [`f1a1717`](https://github.com/igorgolovanov/nestjs-transactional/commit/f1a171793e153a64d2941154891e44603413a8d0), [`127b2a9`](https://github.com/igorgolovanov/nestjs-transactional/commit/127b2a9bc408232a8888b9cea4f3ed31b4ede3f3)]:
  - @nestjs-transactional/core@3.0.0
