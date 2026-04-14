# DD-005: Multiple datasources as a first-class feature

**Alternatives**:
- A single DataSource per app (simpler API)
- Multiple DataSources through a separate package

**Choice**: multi-DataSource support from day one. Each adapter is registered
under a dataSource name (e.g. `'default'`, `'billing'`).

```typescript
@Transactional({ dataSource: 'billing' })
async generateInvoice() { ... }
```

**Trade-off**: the API is slightly more complex (the `dataSource`
parameter), but without this, users cannot realistically use the package in
multi-database projects.

**Phase 14 alignment** (Phase 14.4 → 14.11, 2026-04-27):
The `@nestjs-transactional/typeorm` package is fully aligned with the
Phase 14 multi-adapter conventions. `TypeOrmTransactionalOptions`
exposes the `dataSourceName` field as the canonical identifier
(introduced Phase 14.4; the deprecated `instanceName` alias was
removed in Phase 14.11 — one-phase carry-over for migration).
Phase 14.2 introduced `@Transactional({ dataSource: 'billing' })`
as the user-facing identifier syntax; the legacy
`@Transactional({ adapterInstance: 'billing' })` continues to work
through the same `AdapterRegistry` lookup. Phase 14.4 closed the
verification gap by adding integration tests against real Postgres
that exercise both syntaxes side-by-side, plus cross-dataSource
transaction isolation tests honouring DD-023's keyed-Map guarantee.
Phase 14.10 reworked `TransactionalModule.forRoot` to the multi-
`forRoot` shape (one call per dataSource, mirroring Phase 14.3.2
`OutboxModule` per ADR-019). See [ADR-018](../adr/018-multi-adapter-architecture.md)
for the multi-adapter architecture and its breaking-changes list,
plus the Phase 14.10 + 14.11 addendum at the top of that ADR for
the cleanup record.
