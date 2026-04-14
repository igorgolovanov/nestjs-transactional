# DD-020: Multi-adapter through dataSource-name identifier

**Context**: Phase 14 introduces support for multiple `DataSource`s
(possibly across different ORMs) in a single process — modular
monolith, audit-store split, ORM migration scenarios. We need a way
to distinguish adapter *instances* in DI without conflating the ORM
type and the database identity.

**Alternatives considered**:
- Adapter type (e.g. `'typeorm'`, `'prisma'`) as identifier. Rejected:
  cannot represent two TypeORM-backed dataSources (the most common
  multi-adapter case).
- Composite identifier (e.g. `'typeorm:billing'`). Rejected: forces
  users to think in our internal taxonomy ("which adapter
  implementation") rather than their domain ("which database").

**Decision**: dataSource name is the primary identifier across every
package. Default `'default'` preserves single-adapter ergonomics.
Tokens are deterministically derived from the dataSource name —
e.g. `getTransactionManagerToken('billing')` → a stable string used
in `@Inject(...)`. Matches `@nestjs/typeorm`'s
`getRepositoryToken(Entity, dataSource)` /
`getDataSourceToken(name)` conventions.

**Consequences**: Token utilities live in
`@nestjs-transactional/core` so all packages produce identical token
strings. Single-adapter users see no change. See
[ADR-018](../adr/018-multi-adapter-architecture.md) for the full
design rationale.
