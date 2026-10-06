# ADR-025: A Drizzle ORM adapter that patches the injected database

- **Status**: Accepted
- **Date**: 2026-10-06
- **Related**:
  - ADR-001 (the AsyncLocalStorage context), ADR-004 (public API stability)
  - ADR-024 (the native transaction in the adapter SPI)
  - DD-031 (the workflows bridge contract)
  - DD-033 (the Drizzle adapter contract)

## Context

The core and the bridges are ORM-agnostic. The bridges for
`@nestjs/outbox`, `@nestjs/workflows` and `@nestjs/cqrs` reach the
database through three optional adapter methods only:
`nativeTransaction`, `dialect` and `isRetryableError`. Yet the only
adapter was TypeORM's.

`@nestjs/store-kit`, under the outbox and the workflows, already runs
their SQL through executors for node-postgres, Drizzle, TypeORM, Prisma
and Kysely, each taking that client's own transaction object. An adapter
for one of those clients whose `nativeTransaction` returns that object
works with every bridge unchanged. Drizzle is the first: it is the
client the store-kit documentation leads with, its transaction API has
real savepoints, and it has no Nest integration of its own to compete
with.

What an adapter must add on top of the SPI is ambient access: code that
calls the database inside `@Transactional` has to land in the
transaction without being handed a `tx`. For TypeORM that is the patched
`DataSource` and repositories. Drizzle has no Nest module; the
application registers `drizzle()` under a token of its own.

## Decision

1. **A separate package**, `@nestjs-transactional/drizzle`, one package
   per ORM like `@nestjs-transactional/typeorm`, each with its own peer
   range. It joins the fixed version cohort.
2. **The instance the application registered is patched**, in place.
   `TransactionalDrizzleModule.forRoot({ db: TOKEN })` takes the token.
   Every method of the instance's prototype chain gets an own-property
   wrapper that, at call time, forwards to the `tx` of the transaction
   active for that dataSource, or to the original method. The relational
   `query` objects and `$with` become getters that do the same. An
   existing `@Inject(TOKEN)` follows `@Transactional` with no change.
3. **Transactions are Drizzle's own** `db.transaction()`, always called
   through the method from before the patch. Savepoints are SQL on the
   parent transaction.
4. **PostgreSQL first**, on every Drizzle PostgreSQL driver, and on
   Drizzle 0.40+ and the 1.0 line. MySQL later. SQLite through
   better-sqlite3 is out of scope: its transactions are synchronous.

## Consequences

- Drizzle applications get `@Transactional`, the propagation modes,
  retries, multiple databases and every bridge. With the bridges, a
  Drizzle write, an outbox message and a workflow start commit together.
- The patch depends on Drizzle internals: methods on the prototype
  chain, `query` and `$with` as instance data properties, the
  `entityKind` names. A contract spec pins them, and CI runs the package
  on 0.40.1, 0.45 and 1.0.0-beta.22.
- Only the registered instance follows `@Transactional`. A `drizzle()`
  made outside DI, or a method reference taken before the module starts,
  does not; `getCurrentDrizzleTransaction()` is the explicit way.
- `db.transaction()` inside `@Transactional` reaches the active `tx`, so
  it is a savepoint, the same nesting TypeORM gives
  `dataSource.transaction()`.
- store-kit's `fromDrizzle(db)` on the patched instance joins an active
  transaction through the patched methods too. The bridges stay
  responsible for the isolation check and for tracking pending writes.

## Alternatives considered

- **A `Proxy` under a token of ours** (`@InjectTransactionalDrizzle()`).
  No mutation of the application's object, but every injection point
  changes, and two handles to one database coexist. Rejected for the
  same reason TypeORM's repositories are patched rather than replaced.
- **One package with a subpath per client**, as store-kit does. One
  version line for adapters of very different maturity, and a peer list
  that grows with every client. Rejected for separate packages.
- **Building the adapter on store-kit's executors.** They run SQL on a
  transaction they are handed and never expose the client's own `tx`,
  which is what both ambient access and the bridges need.
