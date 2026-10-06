---
'@nestjs-transactional/drizzle': major
---

New package: `@nestjs-transactional/drizzle`, `@Transactional` for Drizzle ORM

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
