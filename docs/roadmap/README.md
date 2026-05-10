# Implementation Roadmap

Phase-anchored history of the framework. The current state is the
multi-adapter architecture (Phase 14) with the Phase 14.8 example
library and the Phase 14.8f documentation sweep in progress. Per-phase
status retrospectives (post-mortems with metrics, surprises,
follow-ups) live under [`docs/status/`](../status/); convention
discoveries during implementation live in
[`docs/status/conventions.md`](../status/conventions.md).

## Current status

The framework is alpha / in-development. Public API not yet stable;
breaking changes are accepted between 0.x releases. The core
transactional contract, multi-adapter architecture, outbox pattern,
CQRS integration, externalization SPI, and the Tier 1–5 example
library have all shipped. Phase 9 release automation and the
broker-aware externalizers (Phase 12+) remain ahead.

## Era 1 — Foundation (Phases 0–9)

### Phase 0: Monorepo setup (shipped)

pnpm workspaces, TypeScript project references, Jest, ESLint /
Prettier, Changesets, GitHub Actions CI skeleton.

### Phase 1: `@nestjs-transactional/core` (shipped)

The adapter-agnostic foundation:

- `TransactionContext` (AsyncLocalStorage carrier).
- `AdapterRegistry` and `TransactionAdapter` SPI.
- `TransactionManager` with all seven Spring propagation modes
  (`REQUIRED`, `REQUIRES_NEW`, `NESTED`, `SUPPORTS`, `NOT_SUPPORTED`,
  `NEVER`, `MANDATORY`) plus rollback rules and observability
  hooks (before / after commit / rollback).
- `@Transactional` / `@ReadOnly` / `@TransactionalOn` decorators —
  metadata-only, wrapping done at runtime per ADR-005.
- `TransactionalInterceptor` (request boundary) +
  `TransactionalMethodsBootstrap` (service-level wrapping via
  `DiscoveryService`) — both ADR-005 wrapping mechanisms.
- `TransactionalModule.forRoot` / `forRootAsync`.
- `InMemoryTransactionAdapter` shipped via `core/testing` subpath.

### Phase 2: `@nestjs-transactional/typeorm` (shipped)

TypeORM adapter:

- `TypeOrmTransactionAdapter` with `DataSource.transaction(...)`
  for BEGIN / COMMIT / ROLLBACK and raw `SAVEPOINT` SQL for
  `NESTED` propagation.
- `getCurrentEntityManager` and `isInTransaction` helpers.
- `TypeOrmTransactionalModule` (later reshaped in Phase 14.20 — see
  Era 4 below).

### Phase 3: `@nestjs-transactional/cqrs` (shipped)

`@nestjs/cqrs` integration without forking it (ADR-003):

- `TransactionPhase` enum and metadata types.
- `@TransactionalEventsHandler` and `@IntegrationEventsHandler`
  class-level decorators with `I*Handler` interfaces (ADR-014;
  early method-level shape replaced in Phase 10).
- `TransactionalEventDispatcher` with phase routing and
  `TransactionalListenerScanner` for auto-registration.
- `IntegrationEventsHandlerScanner` — smart router that delivers
  through the outbox when `OUTBOX_LISTENER_REGISTRAR` is bound,
  through the in-memory dispatcher otherwise.
- `CqrsHandlerWrapper` + `CqrsTransactionalBootstrap` for
  `OnApplicationBootstrap` handler decoration.
- `TransactionalEventPublisher` + adapter overriding the
  `@nestjs/cqrs` `EventPublisher` token; `AggregateRoot`
  integration via `mergeObjectContext` / `mergeClassContext`.
- `CqrsTransactionalModule.forRoot`.

### Phase 4: CI/CD and publishing (shipped)

GitHub Actions workflow with Changesets-driven release automation
and NPM publishing setup. Initial documentation generation pipeline.

### Phase 5: `@nestjs-transactional/outbox` (shipped)

Persistent Event Publication Registry:

- Lifecycle states (`PUBLISHED`, `PROCESSING`, `COMPLETED`,
  `FAILED`, `RESUBMITTED`).
- `EventSerializer` abstraction with JSON default.
- `EventTypeRegistry`, `EventPublicationRegistry` lifecycle
  coordinator.
- `EventPublicationRepository` SPI.
- `OutboxListenerRegistry` + class-level `@OutboxEventsHandler`
  decorator (ADR-014).
- `OutboxEventPublisher` (later reshaped as a smart facade in
  Phase 14.3 — see DD-024).
- `EventPublicationProcessor` async worker, `StalenessMonitor`,
  `StartupRecoveryService`.
- Operator APIs: `FailedEventPublications`,
  `IncompleteEventPublications`, `CompletedEventPublications`.
- `OutboxModule.forRoot` / `forRootAsync` (process-wide
  infrastructure) + `forFeature` (per-module event-class
  registration). Multi-`forRoot` shape arrived later in
  Phase 14.3.2 — see ADR-019.
- `OutboxProcessingModule` (worker process import).
- `InMemoryEventPublicationRepository` for tests.

### Phase 6: `@nestjs-transactional/outbox-typeorm` (shipped)

TypeORM persistence backend:

- `EventPublicationEntity` (hot table) and
  `EventPublicationArchiveEntity` (cold audit trail) with the four
  worker / operator / cleanup indexes.
- `TypeOrmEventPublicationRepository` implementing the SPI from
  outbox; `tryClaim` conditional `UPDATE`,
  `findReadyForProcessing` using `SELECT ... FOR UPDATE SKIP LOCKED`.
- Schema migration `CreateEventPublication1700000000000` plus
  `SchemaInitializer` for development-time auto-init.
- `OutboxTypeOrmModule` (later reshaped in Phase 14.21 — see
  Era 4).

### Phase 7: cqrs ↔ outbox integration (shipped)

Cross-package wiring without coupling:

- `HybridEventPublisher` — routes `AggregateRoot.commit()` events
  through both the in-memory dispatcher AND the outbox via the
  `OUTBOX_PUBLICATION_SCHEDULER` structural port.
- `IntegrationEventsHandlerScanner` smart routing through
  `OUTBOX_LISTENER_REGISTRAR`.
- `OutboxEventPublisher.scheduleForPublication` for batched writes
  via a single `beforeCommit` hook (DD-019 atomicity).

### Phase 8: Testing utilities (shipped)

`PublishedEvents` and `AssertablePublishedEvents` exported via
the `outbox/testing` subpath. Mirrors Spring Modulith's
`PublishedEvents` / `AssertablePublishedEvents` API. Works through
any wired `EventPublicationRepository` — in-memory for unit tests,
TypeORM for integration tests.

### Phase 9: Documentation and release (in progress)

Documentation tracks:

- Architecture documents (`docs/architecture/`) — core design,
  outbox pattern, outbox-cqrs integration, event externalization.
- ADR-006 through ADR-019 — full Decision-Record set.
- This roadmap and per-phase status retrospectives.
- Migration guide ([`docs/guides/migrating-to-outbox.md`](../guides/migrating-to-outbox.md)).
- Tier 1–5 example library (Phase 14.8 — see Era 4).
- Comprehensive doc sweep (Phase 14.8f — current iteration).

Release tracks remaining:

- Changeset entries for the outbox packages.
- First `1.0.0-alpha.0` release.
- CI matrix tweaks for Docker integration tests, NPM_TOKEN setup.

## Era 2 — Handler API maturation (Phase 10, shipped)

### Phase 10: Class-level handler API redesign

Replaced the early method-level decorators
(`@TransactionalEventsListener`, `@OutboxEventListener`,
`@ApplicationModuleListener`) with class-level decorators
(`@TransactionalEventsHandler`, `@OutboxEventsHandler`,
`@IntegrationEventsHandler`) implementing `I*Handler` interfaces.
Matches `@nestjs/cqrs`'s own `@CommandHandler` / `@QueryHandler`
ergonomics — a class per reaction, one `handle` method.

A second pass renamed `@ApplicationModuleHandler` /
`IApplicationModuleHandler` /
`ApplicationModuleHandlerScanner` to `@IntegrationEventsHandler`
/ `IIntegrationEventHandler` /
`IntegrationEventsHandlerScanner` for clearer intent (the
decorator's job is "deliver this integration event", not
"signal application-module boundary").

Listener id format moved from `${ClassName}.${methodName}` to
`${baseId}#${EventName}` where `baseId` defaults to the class
name (or an explicit `options.id` for stability across renames).

Full rationale: [ADR-014](../adr/014-handler-api-redesign.md).
Migration recipe in
[`docs/guides/migrating-to-outbox.md`](../guides/migrating-to-outbox.md).

## Era 3 — Event externalization (Phase 11, shipped)

Spring Modulith `@Externalized` parity — durable, retryable
delivery of outbox events to external message brokers via
`@nestjs/microservices` `ClientProxy` (DD-016, DD-017, DD-018,
DD-019). Full design rationale in
[ADR-015](../adr/015-event-externalization-architecture.md);
reliability caveat in
[ADR-016](../adr/016-externalization-reliability-semantics.md).

### Phase 11.1: `EventExternalizer` SPI in outbox

- `ExternalizationMetadata` interface (event type → routing
  target).
- `EventExternalizer` interface.
- `EVENT_EXTERNALIZER` DI token (structural port — DD-018).
- `EventPublicationProcessor` invokes the externalizer after
  local handlers, before marking the publication `COMPLETED`
  (execution order per DD-019).

### Phase 11.2: `@Externalized` decorator and registry

- `@Externalized` class decorator with options (`target`,
  `routingKey`, `headers`, `client`).
- `ExternalizationRegistry` keyed by event class name.
- Resolution at processor time via `EventTypeRegistry`.

### Phase 11.3: `@nestjs-transactional/outbox-microservices` package

- `MicroservicesEventExternalizer` implementing the SPI via
  `ClientProxy.emit()`.
- `OutboxMicroservicesModule.forRoot({ defaultClient })` reuses
  an existing `ClientProxy` from the user's `ClientsModule`
  (DD-017) — the package does not register clients itself.
- Bootstrap validation: every event with an `@Externalized`
  mapping has a resolvable client token.

### Phase 11.4: ADR-016 reliability finding

The original Phase 11.4 plan was testcontainers-driven E2E
integration tests against real Kafka and RabbitMQ. The
investigation surfaced a fundamental limitation:
`@nestjs/microservices` `ClientProxy.emit()` does NOT propagate
broker-side delivery failures. With an unreachable broker,
`emit()` resolves successfully and the outbox publication
finalises as `COMPLETED` — even though no message ever reached
a broker.

Consequence: the "broker unreachable → publication FAILED"
reliability test is unreachable from this layer, and the
happy-path test offers limited value when its success signal
cannot distinguish "broker received the message" from "proxy
queued it locally and dropped it".

What shipped instead:

- The testcontainers approach was abandoned. The kafkajs /
  amqplib / amqp-connection-manager dev-deps and the
  `test:integration` script were removed from
  `outbox-microservices`.
- A `microservices-event-externalizer-silent-success.spec.ts`
  unit spec pins the silent-success contract (resolved
  Observable → resolved `externalize()` Promise) so future
  regressions surface as behavioural diffs.
- ADR-016 records the finding, the alternatives weighed, and
  three production mitigation strategies (idempotent producers,
  consumer-side inbox / dedup, broker-aware externalizers).
- A prominent "Reliability semantics" section near the top of
  `packages/outbox-microservices/README.md`.

The `outbox` reliability machinery (retry, recovery, staleness
monitor, `FailedEventPublications.resubmit`) still triggers for
any publication that the externalizer DOES report as failed —
the limitation only applies to broker-side silent failures the
proxy does not surface. Future broker-aware externalizers
(Phase 12+, unscheduled) plugging into the same
`EVENT_EXTERNALIZER` SPI from DD-018 can offer stricter
guarantees without breaking existing users.

### Phase 11.5: Documentation pass

- ADR-015 — event externalization architecture (Accepted) with
  a reliability caveat section deferring to ADR-016.
- [`docs/architecture/event-externalization.md`](../architecture/event-externalization.md)
  — diagrams, end-to-end sequence, failure-mode table, Spring
  Modulith mapping.
- `outbox-microservices` and `outbox` READMEs cross-linked to
  ADR-015 / ADR-016 / architecture doc.
- Root README packages list and roadmap rows updated.
- The example library coverage of externalization landed in
  Phase 14.8c (Era 4) — four examples covering single-broker,
  multi-broker, multi-DataSource, and ADR-016 mitigation
  patterns.

## Era 4 — Multi-adapter architecture (Phase 14, shipped)

Spring-on-NestJS support for multiple `DataSource`s — same ORM
with different DBs (`billing` + `inventory` + `main`), different
ORMs side-by-side (TypeORM + Prisma + Mongoose), or distinct
outbox stacks per bounded-context module. The architectural
centrepiece of the framework. See
[ADR-018](../adr/018-multi-adapter-architecture.md) for the
design rationale, [ADR-019](../adr/019-outbox-multi-forroot-pattern.md)
for the multi-`forRoot` registration mechanism, and
DD-020..DD-024 for the supporting design decisions.

### Phase 14 narrative

The single-adapter architecture conflated "the adapter" with
"the DI scope" — one `TransactionManager`, one
`AdapterRegistry`, one `OutboxModule`, one
`EventPublicationRepository`. Phase 14 unpacked that
conflation by keying every adapter instance, every
transactional context, and every outbox stack on a string
`dataSource` name.

The work landed across two arcs:

1. **Multi-adapter foundation (14.0–14.7)** — token utilities,
   per-DS provider registration, decorator-driven multi-DS
   handler routing (Phase 14.3.1 Categories A and B), and
   migrations across all five packages.
2. **Architectural extensions (14.10–14.21)** — pre-release
   cleanups (alias removals, `forRoot` shape unification),
   transparent transactional repositories (Phase 14.20), and
   the `OutboxTypeOrmModule` reshape mirroring the Phase 14.20
   pattern (Phase 14.21).

The Tier 1–5 example library (Phase 14.8) and the
documentation sweep (Phase 14.8f) close the era by exercising
the final-form architecture end-to-end and aligning every doc
artefact with the shipped state.

### Phase 14.0: Preparation

- ADR-018 drafted.
- DD-020..DD-024 inscribed.
- Phase 14 sub-phases sequenced.
- Migration impact and breaking-change list documented in
  [`docs/migration/multi-adapter.md`](../migration/multi-adapter.md).

### Phase 14.1: Token utilities and inject decorators

Foundation primitives:

- `getTransactionManagerToken(dataSource?)` and siblings
  (`getOutboxPublisherToken`,
  `getEventPublicationRepositoryToken`,
  `getEventTypeRegistryToken`,
  `getStalenessMonitorToken`,
  `getEventPublicationProcessorToken`).
- `@InjectTransactionManager(dataSource?)`,
  `@InjectOutboxPublisher(dataSource?)` thin wrappers over
  `@Inject(token)` for IDE discoverability.
- Unit tests pinning token-shape stability.

### Phase 14.2: Core multi-adapter

`@nestjs-transactional/core`:

- `TransactionalModule.forRoot({ adapter, dataSource? })`
  accepts an `adapter` instance and an optional `dataSource`
  name; default `'default'`.
- `TransactionContext` per-dataSource entries via a single
  shared ALS whose store carries a `Map` keyed by dataSource
  name (DD-023; the per-DS-ALS-instance shape considered and
  rejected for cross-package migration cost — see
  ADR-018 § 7).
- `TransactionManager` registered under
  `getTransactionManagerToken(dataSource)`.
- `@Transactional({ dataSource })` option propagated through
  interceptor + methods bootstrap.
- Backward-compat layer for the `'default'` path so
  single-adapter users see no change.

The original `adapters: [...]` array form (Q1.B compromise)
was later removed in Phase 14.10 — see below.

### Phase 14.3: Outbox multi-adapter

`@nestjs-transactional/outbox`:

- `OutboxModule.forRoot({ ..., dataSource? })` and
  `OutboxModule.forFeature(events, { dataSource? })` register
  every outbox provider under dataSource-derived tokens.
- `EventTypeRegistry` per dataSource — registrations don't
  bleed across dataSources.
- `OutboxEventPublisher` smart facade implementing DD-024
  (detects active dataSource context, routes accordingly,
  explicit override).
- `EventPublicationProcessor` and `StalenessMonitor` bound
  per dataSource.

### Phase 14.3.1: Per-DS handler routing (Categories A and B)

Surfaced during Phase 14.5–14.7 verification. Pre-Phase-14.3.1,
three handler scanners injected a single registry by class
token (aliased to default-DS only), and the cqrs in-memory
dispatcher attached phase hooks via
`TransactionManager.registerBeforeCommit` (first-active-tx
semantics). Decorator-driven multi-DS handler registration was
consequently broken in all four code paths.

The fix split into two architectural categories:

- **Category A (outbox-routed)** — `OutboxListenerScanner`
  and the `IntegrationEventsHandlerScanner` outbox path. Both
  have access to per-DS `EventTypeRegistry` instances; routing
  resolves automatically. The fix introduced
  `outbox/src/serialization/event-type-resolver.ts` (single
  helper `resolveDataSourceByEventTypeName`) consumed by
  three sites
  (`OutboxEventPublisher.resolveDataSource`,
  `OutboxListenerScanner`, `MultiDsOutboxListenerRegistrar`).
  `OutboxListenerScanner` walks per-DS event-type registries
  and routes handlers to the matching per-DS
  `OutboxListenerRegistry`. The new
  `MultiDsOutboxListenerRegistrar` bridges the cqrs
  `OUTBOX_LISTENER_REGISTRAR` structural port — auto-bound
  by `OutboxModule.forRoot` via cross-package
  `Symbol.for(...)` token identity (Convention #8). Cqrs
  scanner source was unchanged, preserving the Phase 14.7
  decoupling.

- **Category B (cqrs in-memory dispatcher)** —
  `TransactionalListenerScanner` and the
  `IntegrationEventsHandlerScanner` dispatcher fallback. The
  cqrs dispatcher is decoupled from outbox (Phase 14.7), so
  there is no event-type registry to consult — the fix uses
  an explicit decorator `dataSource?` option.
  `DispatcherListenerMetadata.dataSource` populated by
  scanners from decorator metadata.
  `TransactionalEventDispatcher.scheduleDispatch` resolves
  the listener's bound DS via
  `TransactionContext.getActiveTransactionByDataSource(dataSource)`
  and pushes hooks directly onto that transaction's hook
  lists, bypassing the manager's first-active-tx semantics.
  Listeners with no matching active tx skip silently when
  other dataSources have transactions running (DD-023
  enforcement); `fallbackExecution: true` still fires when
  no transaction is active anywhere.

Pre-Phase-14.3.1 manual workarounds removed across multi-DS
specs. The `docs/known-limitations.md` entry for the scanner
gaps was removed entirely. ADR-018 carries the addendum
(now folded into the Decision sections per Phase 14.8f).

### Phase 14.3.2: Outbox multi-`forRoot` pivot

`OutboxModule.forRoot({ dataSources: [...] })` array API
replaced with multi-`forRoot` registration — one call per
dataSource. Static-class storage
(`OutboxModule.registrations` Map) coordinates singletons
(smart facade, processing bundle, listener scanner) across
calls. First-call-special pattern adds process-wide providers;
subsequent calls add only their per-DS provider set. Smart
facade late-binds per-DS publishers via `OnModuleInit` +
`ModuleRef.get`. Full design rationale in
[ADR-019](../adr/019-outbox-multi-forroot-pattern.md).

### Phase 14.4: TypeORM adapter migration

`@nestjs-transactional/typeorm`:

- `TransactionalTypeOrmAdapter` constructor accepts a
  `dataSourceName` string (DD-021).
- `getCurrentEntityManager(dataSource?: string)` defaults to
  `'default'`.
- Vocabulary alignment: `instanceName` → `dataSourceName` for
  consistency (with the `@deprecated` alias retained for one
  phase boundary, removed in Phase 14.11).

`TypeOrmTransactionalModule.forFeature` would later be
reshaped to `forRoot` in Phase 14.20 — see below.

### Phase 14.5: Outbox-typeorm migration

`@nestjs-transactional/outbox-typeorm`:

- `typeOrmEventPublicationRepositoryProvider` becomes a
  factory parameterised by dataSource name.
- Repository registered under
  `getEventPublicationRepositoryToken(dataSource)`.
- Schema initializer scopes per-dataSource (one
  `event_publication` table per dataSource by default).

`OutboxTypeOrmModule.forFeature` would later be reshaped to
`forRoot` in Phase 14.21 — see below.

### Phase 14.6: Outbox-microservices migration

`@nestjs-transactional/outbox-microservices`:

- `MicroservicesEventExternalizer` registered per dataSource
  so externalization can be wired independently per outbox
  stack.
- Single global externalizer instance covers every dataSource
  — per-broker routing is via the per-event
  `@Externalized({ client })` axis.

### Phase 14.7: CQRS adapter migration

`@nestjs-transactional/cqrs`:

- `CqrsTransactionalModule.forRoot({ dataSource? })`.
- `IntegrationEventsHandlerScanner` resolves the right
  outbox registrar based on the handler's owning dataSource
  (Category A auto-resolution per Phase 14.3.1).
- `HybridEventPublisher` wraps the smart facade so
  `AggregateRoot` events route correctly in multi-adapter mode.

### Phase 14.8: Examples documentation (Tier 1–5)

Comprehensive example library covering five tiers — foundational
through production-realism. Each Tier 2+ example shipped in its
own commit (Convention #14). All examples live under
[`examples/`](../../examples/); the top-level index is
[`examples/README.md`](../../examples/README.md).

#### Phase 14.8a — Tier 1: Foundational

Four single-DataSource baseline examples:

- `basic-transactional` — `@Transactional()` on
  `@InjectRepository`, Phase 14.20 transparent repository
  showcase, sqljs in-memory.
- `basic-outbox` — `@OutboxEventsHandler` +
  `OutboxEventPublisher`, in-memory test repository.
- `basic-typeorm-outbox` — production-shape outbox with
  Postgres, atomicity proven via testcontainers.
- `basic-cqrs` — Command + Query (auto-readonly) +
  AFTER_COMMIT `@TransactionalEventsHandler`, no DB.

#### Phase 14.8b — Tier 2: Multi-DataSource

Four examples covering the multi-DS axes:

- `multi-datasource-basic` — two DataSources with
  `@Transactional({ dataSource })`, no outbox.
- `multi-datasource-outbox` — per-DS `event_publication`
  tables (ADR-019 multi-`forRoot`).
- `multi-datasource-cqrs` — `@Transactional({ dataSource })`
  per handler (Phase 14.3.1 Category B per-DS hook
  attachment).
- `shared-database-modular-monolith` — one Postgres,
  multiple schemas, per-module outbox stacks
  (Spring-Modulith-style architecture).

#### Phase 14.8c — Tier 3: Externalization

Four examples covering the externalization axes:

- `externalization-kafka` — single-DS + single Kafka broker;
  the canonical Phase 11 baseline.
- `externalization-multi-broker` — Kafka + RabbitMQ + Redis
  pub/sub routed per event via `@Externalized({ client })`.
- `externalization-multi-datasource` — two physical Postgres
  × two `ClientProxy` registrations on a single broker.
- `externalization-with-fallback` — ADR-016 silent-success
  demo + the three production mitigation patterns +
  `FailedEventPublications.resubmit` recovery flow.

#### Phase 14.8d — Tier 4: Advanced patterns

Four advanced examples:

- `saga-pattern` — choreographed multi-step business saga
  over outbox events with compensation handlers.
- `audit-logging` — asymmetric two-DS setup; cross-DS audit
  trail with idempotency on consumer.
- `read-write-separation` — master + replica, only the
  master gets `TypeOrmTransactionalModule`.
- `testing-patterns` — three-tier test scaffold (unit /
  outbox unit / integration).

#### Phase 14.8e — Tier 5: Production realism

Three production-realism examples:

- `e-commerce-orders` — three-DataSource flagship combining
  outbox + CQRS + REST + Kafka externalization. Realistic
  domain (Orders / Inventory / Billing) coordinated through
  outbox integration events. End-to-end runnable
  reference for the final-form architecture.
- `async-config-from-environment` — `forRootAsync` end-to-end
  with `ConfigService` + Joi profiles. Convention #22 framework
  fix landed during this iteration.
- `graceful-shutdown` — `app.enableShutdownHooks()` plus a
  user-side `OutboxDrainService` that polls
  `findIncomplete()` until no row is in `PROCESSING`
  state (Convention #24).

#### Phase 14.8f — Comprehensive documentation pass

This iteration. Five focused commits:

1. Per-package READMEs cross-reference + Phase 14.20/14.21 alignment.
2. Retire pre-tier examples (`cqrs-full-stack`, `outbox-full-stack`)
   absorbed into the Tier 1–5 library.
3. ADR-018 / ADR-019 deep rewrite — addendum-driven running
   history collapsed into final-form Decision sections.
4. `docs/guides/migrating-to-outbox.md` full rewrite — multi-DS
   migration and externalization sections added.
5. This roadmap restructure.

### Phase 14.9: Final verification

- All builds, type-check, lint, unit, integration green.
- Coverage holds across packages.
- Single-adapter examples remain ergonomic (no `'default'`
  strings in user code).
- Multi-adapter examples verified end-to-end against real
  Postgres via testcontainers.

### Phase 14.10: `TransactionalModule` cleanup

Pre-release cleanup unifying `TransactionalModule.forRoot`
with the Phase 14.3.2 `OutboxModule` multi-`forRoot` pattern.
The `adapters: [...]` array form (Phase 14.2 Q1.B compromise)
was removed; one `forRoot` call per dataSource is now the
single shape across the entire module family. Static class
storage (`TransactionalModule.registrations` Map +
`infrastructureRegistered` flag) coordinates singletons
across calls. Default `isGlobal` flipped from `false` to
`true` to match `OutboxModule` and unblock multi-call
cross-DI visibility. Infrastructure-only `forRoot({})`
preserved — the call wires process-wide singletons and
integration packages' `forFeature` continue to register
adapters into `AdapterRegistry` imperatively.

### Phase 14.11: typeorm `instanceName` removal

Pre-release cleanup completing Phase 14.4 vocabulary
alignment. `TypeOrmTransactionalOptions.instanceName`
deprecated alias removed; canonical `dataSourceName` field
remains. Dual-read logic
(`options.dataSourceName ?? options.instanceName ?? 'default'`)
simplified to `options.dataSourceName ?? 'default'`.

Distinct from core's `AdapterRegistration.instanceName` field
(unchanged — different concept) and from
`TypeOrmTransactionAdapter`'s constructor parameter named
`instanceName` (adapter-internal, also unchanged).

### Phase 14.12: outbox-typeorm `adapterInstance` removal

Mirror cleanup for `outbox-typeorm`. Originally scheduled as
a standalone phase; bundled into Phase 14.21 since that phase
was already touching the options interface. The
`adapterInstance` deprecated alias and the `dataSourceName`
field were both removed — both replaced by the unified
`dataSource` string identifier.

### Phase 14.20: Transparent transactional repositories

Spring-style transparent transactional behaviour for
`@nestjs-transactional/typeorm`. Once `TypeOrmTransactionalModule`
is imported, every `Repository` reachable through the
standard `@nestjs/typeorm` injection paths
(`@InjectRepository`, `@InjectEntityManager() em.getRepository(E)`,
`@InjectDataSource() ds.getRepository(E)`,
`ds.manager.save(...)`, custom Repositories via
`Repository.extend`, `TreeRepository`) automatically
dispatches through the active `@Transactional()` scope's
`EntityManager` — no `getCurrentEntityManager()` calls in
user code. Modelled on the `typeorm-transactional` library
pattern (~166K weekly npm downloads).

Architecture:

- **Single `Repository.prototype.manager` getter / setter
  pair** covers all 30+ Repository operations via TypeORM's
  natural `this.manager.<method>(target, ...)` delegation.
  The setter intercepts the constructor's
  `this.manager = manager` and stashes the original under a
  `Symbol.for(...)` key; the getter consults
  `TransactionContext.getActiveTransactionByDataSource(name)`
  and returns the active transactional EM (or the captured
  original on autocommit).
- **`EntityManager.prototype.getRepository` wrapper** stamps
  freshly-resolved repositories so they dispatch correctly
  even when reached through `@InjectEntityManager()`.
- **`Repository.prototype.extend` wrapper** preserves the
  stamp on custom repository chains.
- **Per-instance `DataSource` patches** (`manager` getter,
  `query`, `createQueryBuilder`) — instance-level because
  TypeORM sets these as own-properties; idempotent via a
  `Symbol.for(...)` marker.
- **Module-load-time activation**: patches install on
  `import '@nestjs-transactional/typeorm'`, NOT during
  `forRoot`'s factory. Reason: NestJS resolves providers in
  dependency order; a `useFactory` calling
  `ds.getRepository(E)` may run BEFORE the typeorm module's
  factory, and a Repository constructed pre-patch gets
  `this.manager` as an own-property that permanently
  shadows the prototype getter.
- **Install-once, no revert**:
  `TypeOrmTransactionalModule.resetForTesting` resets the
  managed-DataSource WeakSet only — prototype patches stay
  installed for the process lifetime.

API change (BREAKING, pre-release):

- `TypeOrmTransactionalModule.forFeature({ dataSource: DataSource | factory, ... })`
  → `TypeOrmTransactionalModule.forRoot({ dataSource?: string, isDefault? })`.
  The actual `DataSource` is now resolved from DI under
  `getDataSourceToken(dataSource)`. Multi-DS deployments call
  `forRoot` once per dataSource, mirroring Phase 14.10 and
  Phase 14.3.2.
- `forRootAsync` introduced for async-config use cases (e.g.
  `ConfigService`-driven dataSource selection). A
  framework-level bug surfaced and was fixed during Phase 14.8e
  (Convention #22).

Documented limitations: `@InjectEntityManager() em.save(...)`
direct calls and `BaseEntity` static methods are not patched
and require the `getCurrentEntityManager()` escape hatch or
the Repository pattern. Recorded in
[`docs/known-limitations.md`](../known-limitations.md).

Cross-DS isolation (DD-023) preserved end-to-end — a
Repository bound to dataSource A inside a
`@Transactional({ dataSource: 'B' })` method autocommits.

### Phase 14.21: `OutboxTypeOrmModule` reshape

Phase 14.20's `TypeOrmTransactionalModule.forRoot` pattern
applied to the `outbox-typeorm` package for API consistency.

API change (BREAKING, pre-release):

- `OutboxTypeOrmModule.forFeature({ dataSource: DataSource | factory, dataSourceName?, adapterInstance? })`
  → `OutboxTypeOrmModule.forRoot({ dataSource?: string, schemaInitialization?, isGlobal? })`.
  `DataSource` resolved from DI via `getDataSourceToken(name)`.
- `forRootAsync` introduced for async-config use cases.
- Phase 14.12 bundled — the deprecated `adapterInstance`
  alias and the `dataSourceName` option field both removed
  (replaced by the unified `dataSource` string identifier).

Architecture preserved:

- `typeOrmEventPublicationRepositoryProvider` (the bridge
  function returning a `useExisting` Provider) preserved
  with enhanced JSDoc. The bridge exists because
  `OutboxModule.forRoot` ALWAYS registers something under
  the per-DS repository token (defaults to
  `InMemoryEventPublicationRepository`);
  `OutboxTypeOrmModule.forRoot` cannot register under the
  same `@Global()` token without a NestJS DI conflict. The
  bridge's `useExisting` aliases the official per-DS token
  to a private typeorm-side token.

Atomicity invariant verified by a dedicated
[`atomicity.integration.spec.ts`](../../packages/outbox-typeorm/test/integration/atomicity.integration.spec.ts)
regression net (3 tests against real Postgres). Two parallel
transactional mechanisms reach the same active
`EntityManager` through `TransactionContext`:

1. The Phase 14.20 patched
   `Repository.prototype.manager` getter on
   `@InjectRepository` business Repositories.
2. `TypeOrmEventPublicationRepository`'s explicit
   `getCurrentEntityManager(dataSourceName, fallback)` call.

Both routes converge on the same EM.

## Future phases (not scheduled)

- **Broker-aware externalizers** — native `kafkajs` /
  `amqplib` / `nats` adapters under the same
  `EVENT_EXTERNALIZER` SPI from DD-018, offering at-least-once
  broker-side delivery (closes the ADR-016 silent-success gap).
- **`@nestjs-transactional/outbox-prisma`** — Prisma persistence
  backend. Slots into the Phase 14 multi-adapter contract.
- **`@nestjs-transactional/outbox-mongodb`** — MongoDB
  persistence backend.
- **OpenTelemetry integration** — tracing across transaction
  and event boundaries.
- **ESM dual packaging** — ESM export support alongside CJS.
