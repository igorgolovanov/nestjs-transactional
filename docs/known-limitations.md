# Known Limitations

Limitations of the current implementation. Each entry names the
phase in which it is slated for resolution (or "no fix planned"
with rationale).

## Transaction options — `readOnly` and `timeout` are not enforced

`TransactionOptions.readOnly` and `TransactionOptions.timeout`
(`packages/core/src/types/transaction-options.ts`) are accepted by
the core, carried through `TransactionManager`, and handed to the
adapter — but the shipped `TypeOrmTransactionAdapter`
(`packages/typeorm/src/adapter/typeorm.adapter.ts`) forwards only
`isolation` to `DataSource.transaction`. Both options are therefore
**no-ops today**.

What this means in practice:

- `@ReadOnly()` and `@Transactional({ readOnly: true })` express
  intent and document the method, but a write inside such a method
  still commits. There is no `SET TRANSACTION READ ONLY`, and no
  read-replica routing.
- `@Transactional({ timeout: 5000 })` does not abort anything. A
  long-running transaction runs until the database or the client
  library times it out on its own terms.
- The same applies to `CqrsTransactionalModule`'s
  `defaultQueryOptions: { readOnly: true }` default — query handlers
  are not write-protected by it.

The options are deliberately kept in the type surface rather than
removed: they are the natural extension point for the intended
behaviour, and adapters are free to honour them (the
`TransactionAdapter` contract permits it).

**Fix:** scheduled as item A1 of the
[improvement plan](roadmap/improvement-plan.md) — the direction
(implement `readOnly` via `SET TRANSACTION READ ONLY` on
Postgres-family dialects; implement or formally deprecate `timeout`)
needs a DD before implementation.

## Phase 14 multi-adapter

Single-adapter (default-DS) deployments are unaffected by these
limitations.

The Phase 14.3.1 entry (decorator-driven handler registration in
multi-DS deployments) was removed when Phase 14.3.1 shipped — both
Category A (outbox-routed scanners auto-resolve owning DS via
per-DS event-type registries) and Category B (cqrs in-memory
dispatcher's per-DS hook attachment via explicit decorator
`dataSource` option) now work transparently for multi-DS apps.
See the
[ADR-018](adr/018-multi-adapter-architecture.md) Phase 14.3.1
addendum.

### Phase 14.20 transparent transactional repositories — escape-hatch patterns

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

