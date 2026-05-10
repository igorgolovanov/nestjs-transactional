# Migration to multi-adapter (Phase 14)

This guide enumerates the file-level impact and the breaking
changes Phase 14 introduces. Captured during 14.0 so the
implementation phases (14.1–14.9) can be sequenced without
re-discovering the surface.

For the architectural rationale see
[ADR-018 — multi-adapter architecture](../adr/018-multi-adapter-architecture.md)
and the Phase 14 design decisions
[DD-020](../dd/020-multi-adapter-datasource-name.md) ..
[DD-024](../dd/024-outbox-publisher-facade.md).

## Files / modules affected

### `packages/core`
- `TransactionalModule.forRoot` — accepts `{ adapter, dataSource? }`;
  `forRootAsync` accepts the async equivalent.
- `TransactionContext` — per-dataSource `AsyncLocalStorage` instances
  ([DD-023](../dd/023-independent-tx-contexts-per-ds.md)). Currently
  a single ALS keyed by adapter+instance composite string; refactor
  to a registry of ALS instances keyed by dataSource name.
- `TransactionManager` — registered under
  `getTransactionManagerToken(dataSource)`, no longer a class-token
  singleton.
- `AdapterRegistry` — likely subsumed by per-dataSource provider
  registration; if still needed, gains a dataSource axis.
- New: token utilities (`getTransactionManagerToken`, ...) and inject
  decorators (`@InjectTransactionManager`, ...) — Phase 14.1.

### `packages/typeorm`
- `TransactionalTypeOrmAdapter` — constructor takes a dataSource
  name ([DD-021](../dd/021-adapter-constructor-datasource.md));
  resolves the actual TypeORM `DataSource` via DI.
- `TypeOrmTransactionalModule.forFeature` — `instanceName` field
  renamed to `dataSourceName` for cross-package consistency
  (Phase 14.4 introduced `dataSourceName`; Phase 14.11 removed
  the deprecated `instanceName` alias).
- `getCurrentEntityManager(dataSource?: string, fallback?)` —
  default `'default'`.

### `packages/cqrs`
- `CqrsTransactionalModule.forRoot({ dataSource? })`.
- `CqrsHandlerWrapper` (and the bootstrap that runs it) reads
  `@Transactional({ dataSource })` metadata off handler classes and
  resolves the matching `TransactionManager` via the new tokens.
- `IntegrationEventsHandlerScanner` — handler-level `dataSource`
  option; defaults to `'default'`. Inheritance from the declaring
  module is *not* supported in v1 — handlers state their dataSource
  if non-default.
- `HybridEventPublisher` — wraps the smart facade
  `OutboxEventPublisher` ([DD-024](../dd/024-outbox-publisher-facade.md))
  so AggregateRoot events route correctly in multi-adapter mode.

### `packages/outbox`
- `OutboxModule.forRoot({ ..., dataSource? })` and
  `OutboxModule.forFeature(events, { dataSource? })` — every provider
  goes under dataSource-derived tokens.
- `EventTypeRegistry` — one per dataSource. Cross-dataSource
  registration is forbidden; duplicate detection scoped per
  dataSource.
- `OutboxEventPublisher` — facade implementing
  [DD-024](../dd/024-outbox-publisher-facade.md) (active-context
  detection + explicit override + `'default'` fallback).
- `OutboxEventPublisher` per dataSource — internal class behind the
  facade; not exported by name in user code.
- `EventPublicationRegistry`, `EventPublicationProcessor`,
  `StalenessMonitor`, `StartupRecoveryService` — instantiated per
  dataSource.
- `OutboxProcessingModule` — accepts `{ dataSource? }`; multi-adapter
  worker processes import it once per dataSource they own.
- Operator APIs (`Failed/Incomplete/CompletedEventPublications`) —
  per dataSource.

### `packages/outbox-typeorm`
- `typeOrmEventPublicationRepositoryProvider` — factory parameterised
  by dataSource name.
- `OutboxTypeOrmModule.forFeature({ dataSource?, ... })` — registers
  the repository under
  `getEventPublicationRepositoryToken(dataSource)`.
- `SchemaInitializer` and migration — scoped per dataSource (one
  `event_publication` table per dataSource by default).
- Entities (`EventPublicationEntity`,
  `EventPublicationArchiveEntity`) unchanged at the schema level.

### `packages/outbox-microservices`
- `MicroservicesEventExternalizer` — registered per dataSource so
  externalization can be wired independently per outbox stack.
- `OutboxMicroservicesModule.forRoot({ defaultClient, dataSource? })`.

### `examples/*`
- Every example module updated to the new `forRoot({ adapter,
  dataSource })` shape. Single-adapter examples lean on default
  `'default'` and stay short.
- New `examples/multi-adapter-typeorm/` (Phase 14.8) — two TypeORM
  dataSources, separate outboxes, durable cross-DB integration.

### Tests
- All test fixtures using the current `TransactionalModule.forRoot`
  / `OutboxModule.forRoot` / `OutboxTypeOrmModule.forFeature` shape
  migrate to the new option layout.
- New unit tests for the token utilities, the per-dataSource ALS
  isolation, the smart facade routing, and the `'default'` fallback
  behavior.

## Breaking changes (cumulative across Phase 14)

Acceptable because no package has shipped a stable release yet.

1. `TransactionalModule.forRoot` signature changed (Phase 14.10):
   accepts a single `{ adapter, ... }` per call. Multi-adapter
   setups call `forRoot` once per dataSource. The `adapters: [...]`
   array form (Phase 14.2 Q1.B compromise) was removed; cross-call
   coordination of singletons happens through static class storage
   on `TransactionalModule` itself, mirroring the Phase 14.3.2
   `OutboxModule` mechanism per ADR-019. Default `isGlobal` flipped
   from `false` to `true` to match `OutboxModule` and unblock
   multi-call cross-DI visibility. Infrastructure-only
   `forRoot({})` (no adapter) preserved — the call wires the
   process-wide singletons and integration packages' `forFeature`
   continue to register adapters into the `AdapterRegistry`
   imperatively.
2. `@Transactional` decorator gains a `dataSource` option.
   `@Transactional({ dataSource: 'billing' })`. Default unchanged.
3. `OutboxModule.forRoot` and `OutboxModule.forFeature` accept a
   `dataSource` option.
4. `OutboxTypeOrmModule.forFeature` accepts a `dataSource` option.
   Repository provider registration uses dataSource-derived tokens
   instead of the current single-token shape.
5. `CqrsTransactionalModule.forRoot` accepts a `dataSource` option.
6. `OutboxMicroservicesModule.forRoot` accepts a `dataSource` option.
7. `getCurrentEntityManager(dataSource?: string, fallback?)` —
   parameter renamed from `instanceName` to `dataSource`. Same
   semantics; the rename is for cross-package consistency.
8. `TypeOrmTransactionalModule.forFeature` — `dataSourceName` is
   the canonical identifier (introduced Phase 14.4). The
   deprecated `instanceName` alias was removed in Phase 14.11 —
   one-phase carry-over for migration. The existing `dataSource`
   field continues to hold the actual TypeORM `DataSource`
   instance — see [ADR-018](../adr/018-multi-adapter-architecture.md)
   "Vocabulary asymmetry" for why both names coexist. Same
   semantics throughout.
9. New inject decorators (`@InjectTransactionManager`, etc.) ship.
   Strictly additive — `@Inject(TransactionManager)` (class token)
   continues to work for the default dataSource via a class-token
   alias.
10. Token names ship as a public API
    ([DD-020](../dd/020-multi-adapter-datasource-name.md)). Stable
    strings derived from dataSource name; once shipped, changing
    the token format is itself breaking.

Single-adapter ergonomics stay clean — every new option defaults to
`'default'`. A user with one DB and no `dataSource:` argument
anywhere sees no source-code change beyond the constructor-as-
adapter shape (`new TransactionalTypeOrmAdapter()`). The
constructor-shape change is the one item that touches every
single-adapter consumer.
