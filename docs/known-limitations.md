# Known Limitations

Limitations of the current implementation. Each entry names where
its fix is tracked (or "no fix planned" with rationale).

## Transaction options — `readOnly` is per-dialect, `timeout` is not implemented

Resolved as far as it can be, by
[DD-027](dd/027-readonly-and-timeout-semantics.md). What remains is a
genuine limitation rather than an unimplemented intent.

**`readOnly` is enforced on Postgres-family dialects only.**
`TypeOrmTransactionAdapter` issues `SET TRANSACTION READ ONLY` as the
transaction's first statement on `postgres`, `cockroachdb` and
`aurora-postgres`, so a stray write is refused by the database. On every
other dialect it is a silent no-op:

- **MySQL / MariaDB** — not a gap we can close. `SET TRANSACTION`
  applies to the *next* transaction there and raises `ERROR 1568` inside
  a started one; the access mode must be given as
  `START TRANSACTION READ ONLY`, and TypeORM never exposes that moment.
- **SQLite and the rest** — no transaction access mode to set.

The practical consequence worth planning around: the same code enforces
on Postgres and does not on MySQL or SQLite, so a team developing
against SQLite and deploying to Postgres meets the constraint for the
first time in production. Failing there still beats the write silently
landing, but it is a real difference between environments.

`readOnly` also applies only when the adapter *starts* the transaction —
a `REQUIRED` call joining an existing read-write transaction cannot make
it read-only after the fact. Spring behaves the same way.

**`timeout` is not implemented and deliberately not approximated.**
TypeORM exposes no transaction-level timeout. The nearest dialect
feature, Postgres' `statement_timeout`, bounds each statement rather
than the transaction — `timeout: 5000` on a method issuing four queries
would allow twenty seconds, not five — and a wall-clock deadline cannot
interrupt a statement already in flight. The option stays in the type
surface as the extension point for adapters whose driver has a real
transaction budget; Prisma's `$transaction` accepts exactly this.

**Fix:** none planned for `readOnly` beyond the dialects above. For
`timeout`, a future Prisma adapter can implement it natively.

## Multi-adapter

Single-adapter (default-DS) deployments are unaffected by these
limitations.

Decorator-driven handler registration in multi-DS deployments used
to be listed here; per-dataSource handler routing resolved it. Both
Category A (outbox-routed scanners auto-resolve owning DS via
per-DS event-type registries) and Category B (cqrs in-memory
dispatcher's per-DS hook attachment via explicit decorator
`dataSource` option) now work transparently for multi-DS apps.
See the revision history in
[ADR-018](adr/018-multi-adapter-architecture.md) for the record.

### Transparent transactional repositories — escape-hatch patterns

Two patterns are NOT covered by the prototype patches and require
the user to fall back to `getCurrentEntityManager()` or use a
Repository instead.

1. **`@InjectEntityManager() em.save(Entity, ...)` direct call**
   is NOT transactional. The patched
   `EntityManager.prototype.getRepository` covers
   `em.getRepository(E).save(...)` (Q1 Option A coverage proof
   in the integration tests), but
   `EntityManager.prototype.save` itself is NOT patched. Reason:
   patching the ~14 EntityManager DB methods would require
   per-method recursion-avoidance logic (the active EM is itself
   an EntityManager, so dispatching every method redirects back
   into the same patched code) and a meaningful expansion of
   the patch surface. Trade-off rejected for v1 — the typical
   user pattern is `@InjectRepository`, not raw `EntityManager`
   `.save()`.

   Workaround:

   ```ts
   @Injectable()
   class MyService {
     constructor(@InjectEntityManager() private em: EntityManager) {}

     @Transactional()
     async createUser(name: string) {
       // Option A: use em.getRepository — works transactionally.
       return this.em.getRepository(User).save({ name });

       // Option B: escape hatch — getCurrentEntityManager.
       // const em = getCurrentEntityManager();
       // return em.save(User, { name });
     }
   }
   ```

2. **`BaseEntity` static methods** (`User.save(...)` etc.) are
   NOT supported. The `BaseEntity.useDataSource(...)` API stores
   a captured DataSource reference that bypasses the patched
   `Repository.prototype.manager` getter. typeorm-transactional
   has the same limitation (undocumented). Use the Repository
   pattern instead.

Documented in `packages/typeorm/src/module/typeorm-transactional.module.ts`
JSDoc and surfaces in the `transparent-transactional.integration.spec.ts`
integration test as an explicit "documented limitation" canary —
ensures the limitation stays visible through future refactors.

**Fix:** none currently planned. Future iterations may add a
configurable opt-in `EntityManager.prototype` patching mode if
demand emerges, but the recursion-avoidance complexity makes it
opt-in rather than default behaviour. Tracking under "future
phases (not scheduled)".

