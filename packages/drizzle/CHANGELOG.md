# @nestjs-transactional/drizzle

## 3.0.0

### Major Changes

- [#107](https://github.com/igorgolovanov/nestjs-transactional/pull/107) [`59b1f97`](https://github.com/igorgolovanov/nestjs-transactional/commit/59b1f977b966660f1bd93032dc3c4b3b3f5c5a37) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - New package: `@nestjs-transactional/drizzle`, `@Transactional` for Drizzle ORM
  
  `TransactionalDrizzleModule.forRoot({ db: DB })` takes the token your
  `drizzle()` database is registered under and makes that instance follow
  `@Transactional`: inside a transactional method every call on it runs on
  the transaction, outside one it behaves as before. The propagation
  modes, isolation levels, read-only transactions and
  `@Transactional({ retry })` work as with TypeORM; `NESTED` is a
  savepoint.
  
  PostgreSQL drivers only (node-postgres, postgres-js, PGlite), on
  `drizzle-orm` 0.40 and later, including the 1.0 prereleases. With
  `@nestjs-transactional/outbox` and `@nestjs-transactional/workflows`, a
  Drizzle write, an outbox message and a workflow start commit together;
  give the stores `fromDrizzle(db)`. See ADR-025 and DD-033.

### Patch Changes

- Updated dependencies [[`6209829`](https://github.com/igorgolovanov/nestjs-transactional/commit/6209829f32cf2055519996f33afad4dc11159d3e), [`92bf389`](https://github.com/igorgolovanov/nestjs-transactional/commit/92bf389fe4e2ccf4a1aefa7941f05183bf5afd1b), [`f1a1717`](https://github.com/igorgolovanov/nestjs-transactional/commit/f1a171793e153a64d2941154891e44603413a8d0), [`127b2a9`](https://github.com/igorgolovanov/nestjs-transactional/commit/127b2a9bc408232a8888b9cea4f3ed31b4ede3f3)]:
  - @nestjs-transactional/core@3.0.0
