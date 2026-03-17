# ADR-019: OutboxModule multi-`forRoot` registration pattern

- **Status**: Accepted
- **Date**: 2026-04-27 (Phase 14.3.2)
- **Related**:
  - ADR-018 (multi-adapter architecture, dataSource-name-keyed registration)
  - DD-020 (multi-adapter through dataSource-name identifier)
  - DD-024 (smart `OutboxEventPublisher` facade)

## Context

Phase 14.3 (2026-04-26) shipped multi-adapter `OutboxModule` with an array
API:

```ts
OutboxModule.forRoot({
  dataSources: [
    {},                              // default
    { dataSource: 'billing' },
    { dataSource: 'inventory' },
  ],
})
```

A single `forRoot` call accepted N dataSource configurations, registered
all per-dataSource provider sets at once, and built the singletons
(smart facade, processing bundle, listener scanner) closing over the
fully-known list.

The choice was driven by three constraints that had been baked into
the Phase 14.3 audit:

1. **Provider deduplication**: NestJS deduplicates a `DynamicModule`
   class on import. Two `OutboxModule.forRoot(...)` calls would yield
   two `DynamicModule` literals with the same `module: OutboxModule`
   reference; the second's providers would silently shadow the first.
   The array API sidestepped this by collapsing to a single call.
2. **Singleton resolution**: the smart facade
   (`OutboxEventPublisher`, DD-024) needs to enumerate every per-DS
   publisher to route events. Doing that in a single factory closure
   requires the full list at registration time — easy with the array,
   non-obvious with multi-call.
3. **Familiarity**: `forRoot({ ... })` taking the whole config is the
   shape used by `JwtModule`, `ScheduleModule`, `ConfigModule`, and
   many others. The array seemed analogous.

After the array API landed and Phase 14.3 entered verification, three
issues surfaced:

- **NestJS multi-instance convention asymmetry**. The standard pattern
  in the ecosystem for "register one logical thing per call across
  multiple imports" is multi-`forRoot`/`forFeature`:
  `TypeOrmModule.forRoot(opts1), TypeOrmModule.forRoot(opts2)`,
  `MongooseModule.forRoot(...)`, `ClientsModule.register([...])` (one
  pattern over an array, but explicitly an array of clients, not an
  array of full configs), `BullModule.registerQueue(...)`. The array
  API broke the per-call mental model — a user familiar with the
  ecosystem would naturally expect multi-`forRoot` to work and be
  surprised when it didn't.
- **Configuration locality**. Bounded-context modules import the
  outbox they own. The natural NestJS shape is "each module imports
  its own `forRoot` for its own dataSource"; the array API forced
  every dataSource's config into a single root-level call, inverting
  the locality.
- **`forFeature` already worked per-call**. `OutboxModule.forFeature`
  already followed the per-call convention (each feature module
  imports its own `forFeature` for its own event classes). The
  asymmetry between `forRoot` (must be one call) and `forFeature`
  (must be many calls) read as accidental, not intentional.

User pushback during Phase 14.5 verification crystallised the
mismatch: `OutboxModule.forRoot({ dataSources: [...] })` was rejected
on conventional grounds.

## Decision

Replace the array API with a multi-`forRoot` registration pattern:

```ts
@Module({
  imports: [
    OutboxModule.forRoot({}),                          // default
    OutboxModule.forRoot({ dataSource: 'billing' }),   // billing
    OutboxModule.forRoot({ dataSource: 'inventory' }), // inventory
  ],
})
export class AppModule {}
```

Each `forRoot` call registers a single dataSource's outbox stack.
Cross-call coordination of the singletons (smart facade, processing
bundle, listener scanner) lives in static class storage — mirroring
`@nestjs/typeorm`'s `EntitiesMetadataStorage` pattern.

The mechanism is summarised in five points; the full implementation
lives in `packages/outbox/src/module/outbox.module.ts`.

### 1. Static class storage as the coordination point

`OutboxModule.registrations: Map<string, OutboxRegistrationRecord>`
is a private static property of the module class. Each `forRoot` call
appends its dataSource's record to the Map. The Map is read at
provider-resolution time by singleton factories that close over it —
by the time NestJS resolves a factory, every synchronous `forRoot()`
body has run and the Map is fully populated.

This is the same pattern `@nestjs/typeorm` uses for
`EntitiesMetadataStorage`: a static class-level Map that accumulates
across `forFeature` calls and is read at module-init time. Proven,
NestJS-idiomatic, requires no new abstractions.

### 2. First-call-special for process-wide singletons

The first `forRoot` call to register adds the process-wide providers:

- `OutboxEventPublisher` (the smart facade)
- `OUTBOX_DATA_SOURCE_NAMES` (the value-injected reference to the
  static Map)
- `OUTBOX_PROCESSING_BUNDLE` (per-DS processors / monitors / recovery
  services aggregated for `OutboxProcessingModule`)
- `OutboxListenerScanner`

Subsequent `forRoot` calls add only the per-dataSource provider set
for their dataSource. This avoids NestJS provider-deduplication
collisions on the singletons while still letting every call own its
per-DS providers cleanly.

The "first call" is identified at registration time by checking
whether `registrations.size === 0` before mutating the Map.

### 3. Default-DS class-token aliases as conditional registration

Class tokens like `EventPublicationRegistry`,
`EVENT_PUBLICATION_REPOSITORY`, `EventPublicationProcessor`,
`StalenessMonitor`, etc. preserve a "single-adapter ergonomic" surface
— `module.get(EventPublicationRegistry)` resolves to the default
dataSource's instance when the consumer hasn't opted in to per-DS
tokens.

These aliases register only when the `forRoot` call's dataSource is
`'default'` (explicit or omitted). Multi-DS deployments where there
is no default dataSource never register the class-token aliases —
`module.get(EventPublicationRegistry)` would throw, and consumers
must use the per-DS tokens (`getEventPublicationRegistryToken(ds)`).
Single-DS deployments are unaffected.

### 4. `OnModuleInit` + `ModuleRef` for late binding the smart facade

The smart facade `OutboxEventPublisher` (DD-024) needs to enumerate
every per-DS `DataSourceOutboxPublisher` to route events. The naive
shape would be `useFactory: (...allPerDsPublishers) => new Facade(...)`
with the per-DS tokens listed in `inject`. That doesn't work: NestJS
reads `inject` at module-build time, before later `forRoot` calls
have populated the static Map. The first `forRoot` doesn't yet know
how many `forRoot` calls follow, so it cannot list all the per-DS
tokens up front.

Solution: the facade implements `OnModuleInit` and injects
`ModuleRef` plus `OUTBOX_DATA_SOURCE_NAMES` (a `useValue`-injected
reference to the static Map). At `onModuleInit`, the facade walks the
Map and calls `moduleRef.get(getOutboxPublisherToken(ds))` for each
dataSource — by lifecycle-hook time, every per-DS provider has been
instantiated.

The same pattern handles `OUTBOX_PROCESSING_BUNDLE`: the bundle's
factory returns a lazy-getter object that resolves per-DS processors
/ monitors / recovery services from `ModuleRef` at access time.

### 5. `resetForTesting()` for test isolation

Static state across tests is a classical hazard. Tests that build
multiple `TestingModule`s sequentially call
`OutboxModule.resetForTesting()` in `beforeEach` to clear the Map.
Without it, a residual registration from an earlier test collides
with a later `forRoot` for the same dataSource and throws.

Mirrors the cleanup pattern used with `EntitiesMetadataStorage` in
`@nestjs/typeorm` test suites.

The method is documented `@internal` in JSDoc — it is exposed for
test infrastructure only. Production code calling it after a module
has been initialised does NOT clear the provider tree NestJS already
built; it only affects subsequent `forRoot` calls.

## Alternatives considered

### Per-instance subclassing — `@Module class BillingOutboxModule extends OutboxModule {}`

Rejected. NestJS does deduplicate `DynamicModule`s by reference
identity, so two `BillingOutboxModule.forRoot()` and
`InventoryOutboxModule.forRoot()` would in principle be distinct
modules — bypassing dedup. But this introduces a parallel mental
model: users would need a class per dataSource, the imports list
would carry references to dataSource-specific module classes, and
the relationship between the module class and the dataSource name
would be an undocumented convention. It also makes
`forRoot({ dataSource: 'billing' })` redundant — the class already
encodes the dataSource — yet removing the option breaks the symmetry
with `OutboxModule.forFeature`.

### Single-`forRoot` array API (the Phase 14.3 shape)

Rejected as covered in Context above. The decisive factor was the
ecosystem mismatch: every multi-instance NestJS module ships with
multi-`forRoot`/`forFeature`, and breaking that convention costs more
than the implementation simplicity it bought.

### Builder pattern — `OutboxModule.builder().add(ds1).add(ds2).build()`

Rejected. Idiomatic Java/Spring shape but foreign to NestJS DI. Adds
an extra construction phase that the caller must remember and that
the test infrastructure must replicate. The static-Map pattern from
`@nestjs/typeorm` already solves the same problem in NestJS terms.

### Auto-discovery — scan for adapters via `DiscoveryService`

Rejected. Implicit registration through a discovery scan would
sidestep the explicit `forRoot` boundary, but at the cost of making
"which dataSources are registered?" a runtime question rather than a
module-graph one. NestJS users expect to see their dependencies in
the imports list. Implicit-better-than-explicit is the wrong default
here.

## Consequences

### Positive

- **NestJS-idiomatic**. Multi-`forRoot` is the convention readers
  recognise from `TypeOrmModule`, `MongooseModule`, and others. New
  contributors don't have to learn a one-off API.
- **Configuration locality**. Bounded-context modules each import
  the `forRoot` for the dataSource they own; cross-module
  registration is no longer a single root-level chunk.
- **Symmetry with `forFeature`**. Both the per-DS root and the
  per-feature event registration follow the same per-call pattern.
  The asymmetry that read as accidental is gone.
- **Honest about the cost**. The static-Map + first-call-special
  + `OnModuleInit` + `resetForTesting` mechanism is more code than
  the array API was. But it sits inside the module file — not in
  every consumer — and it leans on a precedent (`@nestjs/typeorm`)
  every NestJS engineer has seen.

### Negative

- **Test infrastructure must call `resetForTesting`**. Tests that
  build multiple modules in sequence — common in Jest's
  `beforeEach` shape — will fail with a confusing
  `forRoot('default') called twice` error if they forget. The
  fix is one line, but it's not obvious from a test-failure
  message. Mitigation: the error message itself names
  `resetForTesting` so the diagnosis-to-fix path is short.
- **The static Map is process-global**. In a NestJS test process
  with many test files, the Map is reused across files. Tests in
  different files that don't reset between cases risk
  cross-contamination if Jest runs them in the same worker. In
  practice Jest workers are isolated and the convention "always
  reset in `beforeEach`" handles it, but the global statelessness
  isn't perfect.
- **Subtle ordering constraint at module-build time**. Singletons
  read the Map at provider-resolution time — by then, every
  synchronous `forRoot` body has run. This relies on NestJS
  evaluating `forRoot` bodies synchronously during module-graph
  construction. If a future NestJS release defers `forRoot`
  evaluation (e.g. for lazy modules), the assumption breaks.
  Documented in the implementation comments so the dependence is
  visible.

### Neutral

- **Sets the precedent for `TransactionalModule`**. Phase 14.10
  applies the same static-Map / first-call-special / `OnModuleInit`
  pattern to `TransactionalModule.forRoot` — closing the
  inconsistency where `TransactionalModule` still accepts an
  `adapters: [...]` array (Phase 14.2 Q1.B) while every other
  multi-DS module shipped multi-`forRoot`. ADR-018 carries an
  addendum noting this alignment; ADR-019 itself is the design
  reference.
- **Future packages adopt the same pattern**. New ORM-backed
  outbox packages (`outbox-prisma`, `outbox-mongodb`) follow
  multi-`forRoot` from day one. The static-Map mechanism is the
  pattern of record for "register one dataSource's stack per call,
  coordinate singletons across calls" in this codebase.

## Implementation reference

Full mechanism: `packages/outbox/src/module/outbox.module.ts` and
`packages/outbox/src/dispatcher/outbox-event-publisher.ts`.

Key surfaces:

- `OutboxModule.registrations` — private static
  `Map<string, OutboxRegistrationRecord>`. Read by singleton
  factories via `privateRegistrations(moduleClass)`.
- `OutboxModule.resetForTesting()` — `@internal` static. Used in
  `beforeEach` to clear the Map.
- `buildFacadePublisherProvider(moduleClass)` — registered by the
  first `forRoot`. Provides `OutboxEventPublisher` + binds
  `OUTBOX_DATA_SOURCE_NAMES` to a live reference to the Map.
- `buildProcessingBundleProvider(moduleClass)` — registered by the
  first `forRoot`. Provides `OUTBOX_PROCESSING_BUNDLE` as a lazy
  getter object that resolves per-DS instances via `ModuleRef`.
- `OutboxEventPublisher.onModuleInit` — late-binds per-DS
  publishers and event-type registries via `ModuleRef.get`.

Test infrastructure precedent:
`packages/outbox/src/module/outbox.module.multi-datasource.spec.ts`
demonstrates the multi-`forRoot` pattern end-to-end with three
dataSources, including manual per-DS listener registration as a
workaround for the Phase 14.3.1 scanner gap.
