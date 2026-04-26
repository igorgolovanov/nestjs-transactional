# Implementation Roadmap

### Phase 0: Monorepo setup (done)
- pnpm workspaces, TypeScript project references
- Jest configuration
- ESLint, Prettier
- Changesets
- CI skeleton (GitHub Actions)

### Phase 1: @nestjs-transactional/core (done)
- Types and interfaces
- TransactionContext (AsyncLocalStorage)
- AdapterRegistry
- InMemoryTransactionAdapter (for testing)
- TransactionManager (with all propagation modes)
- @Transactional decorator (metadata only — see ADR-005)
- TransactionalInterceptor (for the request boundary)
- **ADR-005 document** (before implementation of the bootstrap)
- **TransactionalMethodsBootstrap** (service-level wrapping via
  DiscoveryService)
- TransactionalModule (forRoot / forRootAsync)
- Observability hooks (before/after commit/rollback)

### Phase 2: @nestjs-transactional/typeorm (done)
- TypeOrmTransactionAdapter
- getCurrentEntityManager, isInTransaction helpers
- TypeOrmTransactionalModule
- Multi-datasource support
- Savepoints for NESTED propagation

### Phase 3: @nestjs-transactional/cqrs (done)
- TransactionPhase enum, metadata types
- Class-level `@TransactionalEventsHandler` + `@IntegrationEventsHandler`
  decorators with `I*Handler` interfaces (see ADR-014)
- TransactionalEventDispatcher (with phase routing)
- TransactionalListenerScanner (auto-registration for
  `@TransactionalEventsHandler` classes)
- IntegrationEventsHandlerScanner (smart outbox/in-memory routing for
  `@IntegrationEventsHandler` via the `OUTBOX_LISTENER_REGISTRAR`
  structural port)
- CqrsHandlerWrapper (handler decoration at bootstrap)
- CqrsTransactionalBootstrap (OnApplicationBootstrap)
- TransactionalEventPublisher + Adapter (override of the @nestjs/cqrs
  EventPublisher)
- AggregateRoot integration (mergeObjectContext, mergeClassContext)
- CqrsTransactionalModule

### Phase 4: CI/CD and publishing (done)
- Full GitHub Actions workflow
- Release automation with changesets
- NPM publishing setup
- Documentation generation

### Phase 5: @nestjs-transactional/outbox (in progress)

Core infrastructure for the Event Publication Registry:
- `EventPublication` types and lifecycle states (`PUBLISHED`, `PROCESSING`,
  `COMPLETED`, `FAILED`, `RESUBMITTED`)
- `EventSerializer` abstraction with a JSON default implementation
- `EventTypeRegistry` for deserialization
- `EventPublicationRepository` SPI
- `EventPublicationRegistry` — central lifecycle coordinator
- `OutboxListenerRegistry` and the class-level `@OutboxEventsHandler`
  decorator (see ADR-014)
- `OutboxEventPublisher` — high-level API
- `EventPublicationProcessor` — async worker
- `StalenessMonitor` — detects stuck publications
- `FailedEventPublications`, `IncompleteEventPublications`,
  `CompletedEventPublications` — public APIs
- `StartupRecoveryService` — republish on restart
- `OutboxModule` (`forRoot` / `forRootAsync` for global config,
  `forFeature` for per-module event-class registration — matches
  `TypeOrmModule.forFeature(...)` ergonomics)
- `OutboxProcessingModule`
- In-memory repository for testing

### Phase 6: @nestjs-transactional/outbox-typeorm (planned)

TypeORM persistence implementation:
- `EventPublicationEntity` with proper indexes
- `EventPublicationArchiveEntity` (for ARCHIVE completion mode)
- `TypeOrmEventPublicationRepository` implementing the SPI from outbox
- Uses `FOR UPDATE SKIP LOCKED` for concurrent worker safety
- Schema migration (`createEventPublication`)
- Auto schema initialization (development only)
- `OutboxTypeOrmModule`

### Phase 7: @nestjs-transactional/cqrs outbox integration (planned)

Changes to the existing cqrs package:
- `HybridEventPublisher` — delegates to both the in-memory dispatcher and
  the outbox
- `TransactionalEventPublisherAdapter` updated to use `HybridEventPublisher`
- `IntegrationEventsHandlerScanner` — smart router for
  `@IntegrationEventsHandler` classes; routes to outbox when
  `OUTBOX_LISTENER_REGISTRAR` is bound, falls back to dispatcher otherwise
- `@IntegrationEventsHandler` composite decorator (smart default)
- `OutboxEventPublisher.scheduleForPublication` for a sync publish API
  with batched writes
- `CqrsTransactionalModule` options extended for outbox config

### Phase 8: Testing utilities (planned)

In outbox (`/testing` subpath) and cqrs (`/testing` subpath):
- `PublishedEvents`: inspect events during tests
- `AssertablePublishedEvents` with a fluent API
- Integration with Jest
- Documentation with examples

### Phase 9: Documentation and release (planned)

- `docs/architecture/outbox-pattern.md`
- `docs/architecture/outbox-integration-with-cqrs.md`
- ADR-006 through ADR-009 (and ADR-010 from Phase 7)
- Migration guide: `@TransactionalEventsHandler` → `@OutboxEventsHandler`
- Full working example absorbed into Tier 1 `basic-typeorm-outbox` and Tier 5 `e-commerce-orders` (Phase 14.8a / 14.8e example library)
- CI updates for new packages
- Changesets for version bumps
- Update main README with the expanded roadmap

### Phase 11: Event externalization (planned)

Spring Modulith `@Externalized` parity — durable, retryable delivery
to external message brokers via `@nestjs/microservices` `ClientProxy`
(DD-016, DD-017, DD-018, DD-019). See ADR-015 (planned) for the full
design rationale.

**11.1: `EventExternalizer` SPI in outbox**
- `ExternalizationMetadata` interface (event type → routing target)
- `EventExternalizer` interface
- `EVENT_EXTERNALIZER` DI token (structural port — DD-018)
- Integration in `EventPublicationProcessor` — invoke externalizer
  after local handlers, before marking the publication `COMPLETED`
  (execution order per DD-019)

**11.2: `@Externalized` decorator and registry**
- `@Externalized` class decorator with options (target, key extractor,
  payload mapper)
- `ExternalizationRegistry` service — keyed by event class name
- Integration with `EventTypeRegistry` for resolution at processor time

**11.3: `@nestjs-transactional/outbox-microservices` package**
- `MicroservicesEventExternalizer` — implements the SPI via
  `ClientProxy.emit()`
- `OutboxMicroservicesModule.forRoot({ defaultClient })` reuses an
  existing `ClientProxy` from the user's `ClientsModule` (DD-017) —
  the package does not register clients itself
- Validation on bootstrap: every event with an `@Externalized` mapping
  has a resolvable client token

**11.4: Integration testing — outcome: ADR-016 reliability finding**

Original plan: tests with `testcontainers-node` (Kafka and/or
RabbitMQ), E2E full flow from `@Transactional` method through outbox
to external broker, retry-on-broker-failure verification, single-unit
atomicity / idempotency contract (DD-019).

What actually shipped: the testcontainers approach was abandoned
after the investigation surfaced
[ADR-016](docs/adr/016-externalization-reliability-semantics.md) —
`@nestjs/microservices` `ClientProxy.emit()` does not propagate
broker-side delivery failures. With an unreachable broker, `emit()`
resolves successfully and the outbox publication finalises as
`COMPLETED` regardless of whether the message landed. That makes the
"broker unreachable → publication FAILED" reliability test
unreachable from this layer, and the happy-path test offers limited
value when its success signal cannot distinguish "broker received
the message" from "proxy queued it locally and dropped it".

In place of the integration tests we shipped:

- Removal of the testcontainers / kafkajs / amqplib /
  amqp-connection-manager dev-deps and the `test:integration` script
  from `outbox-microservices` (the deps did not earn their weight
  given the finding).
- A new `microservices-event-externalizer-silent-success.spec.ts`
  unit spec that pins the silent-success contract (resolved
  Observable → resolved `externalize()` Promise) so future regressions
  surface as behavioral diffs.
- ADR-016 itself, recording the finding, the alternatives weighed,
  and three production mitigation strategies.
- A prominent "Reliability semantics" section near the top of
  `packages/outbox-microservices/README.md` so users see the
  limitation before adopting.

The `outbox` reliability machinery (retry, recovery, staleness
monitor, `FailedEventPublications.resubmit`) still triggers for any
publication that the externalizer DOES report as failed — the
limitation only applies to broker-side silent failures the proxy
does not surface. Future broker-aware externalizers (Phase 12+,
unscheduled) plugging into the same `EVENT_EXTERNALIZER` SPI from
DD-018 can offer stricter guarantees without breaking existing
users.

**11.5: Documentation pass — split into 11.5a (docs) and 11.5b (example)**

*11.5a (shipped, this iteration):*
- ADR-015 — event externalization architecture (Accepted) with a
  reliability caveat section that defers to ADR-016.
- `docs/architecture/event-externalization.md` — diagrams,
  end-to-end sequence, failure-mode table, reliability semantics,
  Spring Modulith mapping.
- `outbox-microservices` README polished with cross-links to
  ADR-015 / ADR-016 / architecture doc + Spring Modulith mapping
  summary.
- `outbox` README's existing externalization section linked to
  ADR-015 / ADR-016 / architecture doc.
- Root README packages list now includes `outbox-microservices`;
  Roadmap rows added for Phase 10 (handler rename) and Phase 11
  (event externalization, in progress); Documentation index links
  the new architecture doc and ADR-015 / ADR-016.
- Deferred Phase B doc-wide sweep from Iteration 10 completed —
  every remaining `@ApplicationModuleHandler` /
  `IApplicationModuleHandler` / `ApplicationModuleHandlerScanner`
  reference across READMEs, architecture docs, migration guide,
  and examples renamed to `@IntegrationEventsHandler` /
  `IIntegrationEventHandler` / `IntegrationEventsHandlerScanner`.
  ADR-014 keeps its body intact as historical record but gains a
  top note pointing at the second-pass rename.

*11.5b (planned):*
- `examples/outbox-externalization/` — full Postgres + Kafka stack
  via docker-compose, real running NestJS app demonstrating the
  publish → outbox → externalize flow plus the ADR-016 reliability
  limitation in action ("stop the broker, observe COMPLETED").
- Verified-running end-to-end against the docker-compose stack.

### Phase 14: Multi-adapter architecture (planned)

Spring-on-NestJS support for multiple `DataSource`s — same ORM with
different DBs (`billing` + `inventory` + `main`), different ORMs
side-by-side (TypeORM + Prisma + Mongoose), or distinct outbox
stacks per bounded-context module. See ADR-018 for the design
rationale and DD-020..DD-024 for the design decisions.

**14.0: Preparation (this iteration)**
- ADR-018 — multi-adapter architecture
- DD-020..DD-024 inscribed
- Phase 14 sub-phases sequenced
- Migration impact and breaking-change list documented
- No code changes

**14.1: Token utilities and inject decorators (foundation)**
- `getTransactionManagerToken(dataSource?: string): string` and
  siblings (`getOutboxPublisherToken`,
  `getEventPublicationRepositoryToken`,
  `getEventTypeRegistryToken`, `getStalenessMonitorToken`,
  `getEventPublicationProcessorToken`, etc.)
- Inject decorators: `@InjectTransactionManager(dataSource?)`,
  `@InjectOutboxPublisher(dataSource?)`, etc. — thin wrappers over
  `@Inject(token)` for IDE discoverability
- Unit tests for token shape stability

**14.2: Core multi-adapter (`@nestjs-transactional/core`)**
- `TransactionalModule.forRoot({ adapter, dataSource? })` accepts
  an `adapter` instance and an optional `dataSource` name; default
  `'default'`
- `TransactionContext` per-dataSource ALS instances (DD-023)
- `TransactionManager` registered under
  `getTransactionManagerToken(dataSource)`
- `@Transactional({ dataSource })` option propagated through
  interceptor + methods bootstrap (ADR-005 wrappers stay; they read
  the dataSource off the metadata)
- Backward-compat layer for the `'default'` path so single-adapter
  users see no change

**14.3: Outbox multi-adapter (`@nestjs-transactional/outbox`)**
- `OutboxModule.forRoot({ ..., dataSource? })` and
  `OutboxModule.forFeature(events, { dataSource? })` register every
  outbox provider under dataSource-derived tokens
- `EventTypeRegistry` per dataSource — registrations don't bleed
  across dataSources (a `'billing'` event type cannot be picked up
  by an `'inventory'` deserializer)
- `OutboxEventPublisher` smart facade implementing DD-024 (detect
  active dataSource context, route accordingly, explicit override)
- `EventPublicationProcessor` and `StalenessMonitor` bound per
  dataSource

**14.3.1: Bundled scanner + dispatcher per-DS routing (shipped 2026-04-29)**

Surfaced during Phase 14.5–14.7 verification. Pre-Phase-14.3.1, three
handler scanners injected a single registry by class token (aliased
to the default-DS only), and the cqrs in-memory dispatcher attached
phase hooks via `TransactionManager.registerBeforeCommit` (first-
active-tx semantics). Decorator-driven multi-DS handler registration
was consequently broken in all four code paths.

Audit reframed the fix into two architectural categories:

- **Category A (outbox-routed)** — `OutboxListenerScanner` and
  `IntegrationEventsHandlerScanner` outbox path. Both have access to
  per-DS `EventTypeRegistry` instances; routing resolves
  automatically.
- **Category B (cqrs in-memory dispatcher)** —
  `TransactionalListenerScanner` and the
  `IntegrationEventsHandlerScanner` dispatcher fallback. The cqrs
  dispatcher is decoupled from outbox (Phase 14.7), so there is no
  event-type registry to consult — fix uses an explicit decorator
  `dataSource?` option.

Two-commit shape:

- **Commit 1 (Category A)**: New
  `outbox/src/serialization/event-type-resolver.ts` — single helper
  `resolveDataSourceByEventTypeName` consumed by three sites
  (`OutboxEventPublisher.resolveDataSource`,
  `OutboxListenerScanner`, `MultiDsOutboxListenerRegistrar`).
  `OutboxListenerScanner` refactored to inject `ModuleRef` +
  `OUTBOX_DATA_SOURCE_NAMES`, walks per-DS event-type registries,
  routes handlers to the matching per-DS `OutboxListenerRegistry`.
  New `MultiDsOutboxListenerRegistrar` (in outbox) bridges cqrs's
  `OUTBOX_LISTENER_REGISTRAR` structural port — auto-bound by
  `OutboxModule.forRoot` via cross-package `Symbol.for(...)` token
  identity (Convention #8). Cqrs scanner source unchanged —
  Phase 14.7 decoupling preserved 100%. Edge cases (event registered
  to 0/multiple DSes, handler events spanning multiple DSes) throw
  at scanner bootstrap with actionable messages.
- **Commit 2 (Category B)**: `dataSource?: string` field added to
  `TransactionalEventsHandlerOptions` and
  `IntegrationEventsHandlerOptions` (default `'default'`).
  `DispatcherListenerMetadata.dataSource` populated by scanners from
  decorator metadata. `TransactionalEventDispatcher.scheduleDispatch`
  resolves the listener's bound DS via
  `TransactionContext.getActiveTransactionByDataSource(dataSource)`
  and pushes hooks directly onto that transaction's hook lists,
  bypassing manager's first-active-tx semantics. Same pattern as
  `DataSourceOutboxPublisher.scheduleForPublication` (Phase 14.3).
  Listeners with no matching active tx skip silently when other
  dataSources have transactions running (DD-023 enforcement);
  fallbackExecution still fires when no transaction is active
  anywhere.

Pre-Phase-14.3.1 manual workarounds removed across multi-DS specs.
The [`docs/known-limitations.md`](../known-limitations.md) entry
for the scanner gaps was removed entirely. ADR-018 carries Phase
14.3.1 addendum.

**14.4: TypeORM adapter migration (`@nestjs-transactional/typeorm`)**
- `TransactionalTypeOrmAdapter` constructor accepts a dataSource
  name (DD-021); resolves the actual TypeORM `DataSource` via DI
  using the dataSource name as the lookup key
- `getCurrentEntityManager(dataSource?: string)` defaults to
  `'default'`
- `TypeOrmTransactionalModule.forFeature({ dataSourceName, ... })`
  unchanged in surface but renames `instanceName` → `dataSourceName`
  for consistency. The existing `dataSource` field (holding the
  actual TypeORM `DataSource` instance) keeps its name — see ADR-018
  "Vocabulary asymmetry" for the two-fields-two-purposes rationale.
  `instanceName` preserved as `@deprecated` alias.

**14.5: Outbox-typeorm migration (`@nestjs-transactional/outbox-typeorm`)**
- `typeOrmEventPublicationRepositoryProvider` becomes a factory
  parameterised by dataSource name
- `OutboxTypeOrmModule.forFeature({ dataSource?, ... })` registers
  the repository under `getEventPublicationRepositoryToken(dataSource)`
- Schema initializer scopes per-dataSource (one
  `event_publication` table per dataSource by default; override
  available)

**14.6: Outbox-microservices migration**
  (`@nestjs-transactional/outbox-microservices`)
- `MicroservicesEventExternalizer` registered per dataSource so
  externalization can be wired independently per outbox stack
- `OutboxMicroservicesModule.forRoot({ defaultClient, dataSource? })`

**14.7: CQRS adapter migration (`@nestjs-transactional/cqrs`)**
- `CqrsTransactionalModule.forRoot({ dataSource? })`
- `IntegrationEventsHandlerScanner` resolves the right outbox
  registrar based on the handler's class — open question: do
  handlers carry their own `dataSource` option, or inherit from the
  module they're declared in? Default plan: handler-level option,
  inherits if absent.
- `HybridEventPublisher` wraps the smart facade so AggregateRoot
  events route correctly in multi-adapter mode

**14.8: Examples documentation (Tier 1–5 sub-phases)**

Comprehensive example library covering five tiers — foundational
through production-realism. Each sub-phase shippable independently;
each Tier 2+ example ships in its own commit (Convention #14).

**14.8a — Tier 1: Foundational (4 examples, shipped 2026-05-08)**

- `basic-transactional` — single DataSource, only `@Transactional`
  decorator, no outbox/CQRS, demonstrates Phase 14.20 transparent
  repositories, ~50 lines service code.
  Goal: simplest possible setup, declarative transactions без extras.
- `basic-outbox` — single DataSource, `@Transactional` + outbox
  (in-memory persistence), no externalization, `@OutboxEventsHandler`
  for event consumption.
  Goal: outbox pattern intro без TypeORM persistence complexity.
- `basic-typeorm-outbox` — single DataSource, `@Transactional` +
  outbox + outbox-typeorm, real Postgres persistence,
  `@OutboxEventsHandler` local consumption.
  Goal: production-realistic single-DS setup.
- `basic-cqrs` — single DataSource, `@nestjs/cqrs` integration,
  `@Transactional` + Commands / Queries / Events,
  `@TransactionalEventsHandler`.
  Goal: CQRS integration без outbox complexity.

Shipped in 4 commits: b38f4b8, d947632, ce5bb99, 3a6082b. 12 tests
(9 unit + 3 testcontainers integration). `examples/README.md` index
introduced.

**14.8b — Tier 2: Multi-DataSource (4 examples, shipped 2026-05-09)**

- `multi-datasource-basic` — two DataSources (billing + inventory),
  `@Transactional({ dataSource })`, no outbox/CQRS, cross-DS
  independence demonstrated.
  Goal: multi-DS transactional concept без outbox complexity. Что
  happens when you have two databases.
- `multi-datasource-outbox` — two DataSources each with own outbox,
  per-DS event types via `forFeature({ dataSource })`,
  decorator-driven handler registration (Phase 14.3.1), real Postgres
  per-DS `event_publication` tables.
  Goal: production multi-DS setup. Atomicity invariant demonstrated
  — outbox in same DB as business data.
- `multi-datasource-cqrs` — two DataSources, CQRS handlers с
  dataSource option (Phase 14.3.1 Category B), per-DS transaction
  context.
  Goal: CQRS + multi-DS combination.
- `shared-database-modular-monolith` — same Postgres, different
  schemas / logical separation, Spring Modulith-style architecture,
  module-per-domain с separate outbox per module.
  Goal: modular monolith pattern. Different namespace, same
  infrastructure.

Shipped in 5 commits: 34cf35e (basic rename + rewrite), 8d1ce01
(outbox + testcontainers), 3bd2071 (cqrs Cat B), 1d0f0e8
(modular-monolith Postgres schemas), and this closure commit. 17
tests (5 unit + 12 testcontainers integration). 591/591 package
baseline preserved across all five commits.

**14.8c — Tier 3: Externalization (4 examples, shipped 2026-05-09)**

- `externalization-kafka` — single DataSource + single Kafka broker
  via `@nestjs/microservices` `ClientProxy`. Canonical Phase 11
  baseline: `@Externalized({ target, routingKey, headers })` on
  event class, `OutboxMicroservicesModule.forRoot({ defaultClient })`
  wiring. Postgres real via testcontainers; ClientProxy mocked in
  jest; docker-compose Kafka KRaft for visual demo. 4 integration
  tests (atomic dual delivery, atomic rollback, multiple orders
  independent, externalizer-throws → publication FAILED).
- `externalization-multi-broker` — single DataSource, three brokers
  (Kafka topic `orders.placed` + RabbitMQ queue `refunds` + Redis
  pub/sub channel `cache.invalidated`). Per-event
  `@Externalized({ client })` routing via single global
  externalizer; three local handlers; one `@Transactional` method
  publishing three events of three shapes. 6 integration tests pin
  per-event routing isolation, atomicity across the fan-out, and
  per-publication failure isolation (Kafka throw → only that row
  FAILED, RabbitMQ + Redis emits still complete).
- `externalization-multi-datasource` — combines Tier 2 multi-DS
  outbox (ADR-019 per-DS forRoot) with Tier 3 externalization.
  Two physical Postgres DBs × two ClientProxy registrations on a
  single RabbitMQ broker (BILLING_BROKER queue billing.events,
  INVENTORY_BROKER queue inventory.events). Single global
  `MicroservicesEventExternalizer` covers BOTH DSes — per-event
  `@Externalized({ client })` is the routing axis. 6 integration
  tests pin per-DS routing, cross-DS rollback isolation in both
  directions, mixed flow independence, and per-broker / per-DS
  failure isolation.
- `externalization-with-fallback` — ADR-016 silent-success
  demonstration plus the three production mitigation patterns.
  Single Postgres DS + RabbitMQ; mocked-emit silent-success
  contract pinned by integration test (mock and real unreachable
  broker produce indistinguishable framework behavior); consumer-
  side inbox / dedup template (`ProcessedRefundEntity` table keyed
  on publication id, two tests); `FailedEventPublications.resubmit`
  recovery flow (single + batch). Visual demo includes manual
  `docker-compose stop rabbitmq` so the ADR-016 limit is
  observable on a real broker.

**14.8d — Tier 4: Advanced patterns (4 examples, shipped 2026-05-10)**

- `saga-pattern` — long-running transaction across multiple steps,
  compensating actions on failure, outbox for inter-step
  coordination.
  Goal: distributed transaction alternative. How to coordinate
  multi-step processes.
- `audit-logging` — `@Transactional` на business operations,
  separate audit dataSource, audit events через outbox в audit-DS.
  Goal: common architectural pattern. Business data + audit trail
  separation.
- `read-write-separation` — master/replica DataSource setup,
  `@Transactional` для writes (master), read queries from replica,
  `@InjectRepository(Entity, 'replica')` для reads.
  Goal: common scaling pattern. Не CQRS necessarily, just read
  replicas.
- `testing-patterns` — mock adapter usage, testcontainers
  integration tests, in-memory outbox для fast tests, comprehensive
  test setup demonstration.
  Goal: how к test apps using framework. Critical для adoption.

**14.8e — Tier 5: Production realism (3 examples, shipped 2026-05-10)**

- `e-commerce-orders` — realistic domain (Order, Product, Customer),
  multi-DS (orders, inventory, payments separate), outbox для
  inter-service communication, externalization к Kafka, CQRS для
  read/write.
  Goal: complete realistic application. End-to-end demonstration.
- `async-config-from-environment` — `forRootAsync` с `ConfigService`,
  environment-based DataSource configuration, different configs для
  dev/staging/prod, production-ready setup.
  Goal: how к structure for real deployments. Static config
  insufficient.
- `graceful-shutdown` — outbox processor draining, in-flight
  transaction completion, connection cleanup, `@nestjs/common`
  lifecycle hooks integration.
  Goal: production deployment concerns. Shutdown handling matters.

**14.8f — Comprehensive documentation pass**

- Examples top-level README polish (after Tier 5 lands)
- Per-package README sync with full example library cross-references
- Migration guide updates referencing the new examples
- ADR-018 / ADR-019 final-form review
- Roadmap update consolidating Phase 14.8 narrative

**14.9: Final verification**
- All builds, type-check, lint, unit, integration green
- Coverage holds across packages
- Single-adapter examples remain ergonomic (no `'default'` strings
  in user code)
- Multi-adapter example end-to-end against real Postgres

**14.10: TransactionalModule cleanup (shipped 2026-04-27)**

Pre-release cleanup unifying `TransactionalModule.forRoot` with the
Phase 14.3.2 `OutboxModule` multi-`forRoot` pattern (ADR-019).
Removes the `adapters: [...]` array form (Phase 14.2 Q1.B
compromise) in favour of one `forRoot` call per dataSource. Static
class storage (`TransactionalModule.registrations` Map +
`infrastructureRegistered` flag) coordinates singletons across
calls. Default `isGlobal` flips from `false` to `true` to match
`OutboxModule` and unblock multi-call cross-DI visibility.
Infrastructure-only `forRoot({})` preserved — the call wires
process-wide singletons and integration packages' `forFeature`
continue to register adapters into `AdapterRegistry` imperatively.
ADR-018 second addendum captures the landing record.

**14.11: typeorm `instanceName` removal (shipped 2026-04-27)**

Pre-release cleanup completing Phase 14.4 vocabulary alignment.
`TypeOrmTransactionalOptions.instanceName` deprecated alias
removed; canonical `dataSourceName` field remains. Dual-read
logic (`options.dataSourceName ?? options.instanceName ?? 'default'`)
simplified to `options.dataSourceName ?? 'default'`. The alias
was retained for one phase boundary so consumers had time to
migrate.

Distinct from core's `AdapterRegistration.instanceName` field
(unchanged — different concept) and from
`TypeOrmTransactionAdapter`'s constructor parameter named
`instanceName` (adapter-internal, also unchanged).

**14.12: outbox-typeorm `adapterInstance` removal (shipped 2026-04-29, bundled into 14.21)**

Mirror cleanup for `outbox-typeorm`. Originally scheduled as a
standalone phase, bundled into Phase 14.21 since that phase was
already touching the options interface. The `adapterInstance`
deprecated alias and the `dataSourceName` field were both removed —
both replaced by the unified `dataSource` string identifier. The
two integration tests that verified the deprecated-alias precedence
behaviour were deleted (no longer expressible).

**14.21: OutboxTypeOrmModule reshape (shipped 2026-04-29)**

Phase 14.20's `TypeOrmTransactionalModule.forRoot` pattern applied
to the `outbox-typeorm` package for API consistency.

API change (BREAKING, pre-release acceptable):

- `OutboxTypeOrmModule.forFeature({ dataSource: DataSource | factory, dataSourceName?, adapterInstance? })`
  → `OutboxTypeOrmModule.forRoot({ dataSource?: string, schemaInitialization?, isGlobal? })`.
  The actual `DataSource` is now resolved from DI via
  `getDataSourceToken(name)` — same convention `@nestjs/typeorm`
  uses for `@InjectRepository(E, dataSource)`. Multi-DS deployments
  call `forRoot` once per dataSource, mirroring Phase 14.20.
- `forRootAsync` introduced for async-config use cases. The
  `dataSource` name is statically declared in the async options
  object; only `schemaInitialization` is async-resolved through the
  factory (per-DS provider tokens require synchronous name
  resolution).
- **Phase 14.12 bundled** — the deprecated `adapterInstance` alias
  and the `dataSourceName` option field both removed (replaced by
  the unified `dataSource` string identifier). Closes the alias
  cleanup chain that Phase 14.10/14.11 began.

Architecture preserved:

- `typeOrmEventPublicationRepositoryProvider` (the bridge function
  returning an `useExisting` Provider) preserved with **enhanced
  JSDoc** explaining its purpose. The bridge exists because
  `OutboxModule.forRoot` ALWAYS registers something under the
  per-DS repository token (defaults to
  `InMemoryEventPublicationRepository`); `OutboxTypeOrmModule.forRoot`
  cannot register under the same `@Global()` token without a NestJS
  DI conflict. The bridge's `useExisting` aliases the official
  per-DS token to a private typeorm-side token. Audit considered
  removing the bridge but rejected on test-migration burden grounds
  (14+ outbox unit tests rely on `OutboxModule.forRoot({})`
  defaulting to in-memory).
- `TypeOrmEventPublicationRepository` constructor unchanged
  (`(dataSource: DataSource, dataSourceName = 'default')`). The
  module factory passes both arguments after resolving the
  DataSource from DI.
- `SchemaInitializer` per-DS lifecycle preserved (zero behavioural
  change) — module factory just resolves DataSource via DI instead
  of from the option.

Atomicity invariant verified end-to-end with a dedicated
`atomicity.integration.spec.ts` regression net (3 tests against
real Postgres):

- Successful `@Transactional` commits BOTH business row AND
  `event_publication` row in one transaction.
- Rollback in `@Transactional` discards BOTH rows together.
- Multiple `@Transactional` methods run independently — each tx is
  its own atomic unit.

Two parallel transactional mechanisms reach the SAME active
`EntityManager` through `TransactionContext`:

1. Phase 14.20 patched `Repository.prototype.manager` getter on
   `@InjectRepository` business Repositories.
2. `TypeOrmEventPublicationRepository`'s explicit
   `getCurrentEntityManager(dataSourceName, fallback)` call.

Both routes converge on the same EM. Phase 14.21 doesn't change
this contract, but the integration test pins it explicitly.

Tests: 31 outbox-typeorm integration tests (was 33, minus 2
deprecated-alias-precedence tests) + 3 new atomicity tests = 34
total, all passing against real Postgres.

Cross-package consumers (3 outbox-typeorm integration specs +
1 example) migrated mechanically. Cqrs package does not consume
`OutboxTypeOrmModule` directly.

ADR-018 carries a Phase 14.21 addendum documenting the
architectural finding (bridge function preservation rationale)
and the three options weighed during audit.

**14.20: Transparent transactional repositories (shipped 2026-04-29)**

Spring-style transparent transactional behaviour for
`@nestjs-transactional/typeorm`. Once `TypeOrmTransactionalModule`
is imported, every `Repository` reachable through the standard
`@nestjs/typeorm` injection paths (`@InjectRepository`,
`@InjectEntityManager() em.getRepository(E)`,
`@InjectDataSource() ds.getRepository(E)`,
`ds.manager.save(...)`, custom Repositories via `Repository.extend`,
TreeRepository, etc.) automatically dispatches through the active
`@Transactional()` scope's `EntityManager` — no
`getCurrentEntityManager()` calls in user code. Modelled on the
`typeorm-transactional` library pattern (~166K weekly npm
downloads).

Architecture:

- **Single Repository.prototype.manager getter/setter pair**
  covers all 30+ Repository operations via TypeORM's natural
  `this.manager.<method>(target, ...)` delegation. The setter
  intercepts the constructor's `this.manager = manager` and
  stashes the original under a `Symbol.for(...)` key; the getter
  consults `TransactionContext.getActiveTransactionByDataSource(name)`
  and returns the active transactional EM (or the captured
  original on autocommit).
- **EntityManager.prototype.getRepository wrapper** stamps
  freshly-resolved repositories so they dispatch correctly even
  when reached through `@InjectEntityManager()`.
- **Repository.prototype.extend wrapper** preserves the stamp on
  custom repository chains.
- **Per-instance DataSource patches** (`manager` getter, `query`,
  `createQueryBuilder`) — instance-level because TypeORM sets
  these as own-properties; idempotent via a `Symbol.for(...)`
  marker.
- **Module-load-time activation**: patches install on
  `import '@nestjs-transactional/typeorm'`, NOT during
  `forRoot`'s factory. Reason: NestJS resolves providers in
  dependency order; a `useFactory` calling `ds.getRepository(E)`
  may run BEFORE the typeorm module's factory, and a Repository
  constructed pre-patch gets `this.manager` as an own-property
  that permanently shadows the prototype getter. Module-load
  side effect guarantees patches are in place before any DI
  factory observes `Repository.prototype`.
- **Install-once, no revert**: `TypeOrmTransactionalModule.resetForTesting`
  resets the managed-DataSource WeakSet only — prototype patches
  stay installed for the process lifetime. Reverting would
  silently break Repository instances constructed under the
  patched setter (no own-property `manager`; deletion leaves
  `repo.manager === undefined`). Tests destroy and recreate the
  DataSource between cases.

API change (BREAKING, pre-release acceptable):

- `TypeOrmTransactionalModule.forFeature({ dataSource: DataSource | factory, ... })`
  → `TypeOrmTransactionalModule.forRoot({ dataSource?: string, isDefault? })`.
  The actual `DataSource` instance is now resolved from DI under
  `getDataSourceToken(dataSource)` (same convention `@nestjs/typeorm`
  uses for `@InjectRepository(E, dataSource)`). Multi-DS
  deployments call `forRoot` once per dataSource, mirroring
  Phase 14.10 (`TransactionalModule`) and Phase 14.3.2
  (`OutboxModule` per ADR-019).
- `forRootAsync` introduced for async-config use cases (e.g.
  `ConfigService`-driven dataSource selection) with the same
  documented per-DS-token limitation as Phase 14.10.

Documented limitations:

- `@InjectEntityManager() em.save(Entity, ...)` direct call is
  NOT transactional. The patched
  `EntityManager.prototype.getRepository` covers
  `em.getRepository(E).save(...)`, but
  `EntityManager.prototype.save` itself is not patched. Escape
  hatches: use the Repository pattern, or call
  `getCurrentEntityManager()`.
- `BaseEntity` static methods (`User.save(...)` etc.) are NOT
  supported. The `BaseEntity.useDataSource(...)` API stores a
  captured DataSource reference that bypasses the patches.

Cross-DS isolation (DD-023) is preserved end-to-end: a Repository
bound to dataSource A inside a `@Transactional({ dataSource: 'B' })`
method autocommits — its `manager` getter looks up active
transaction for dataSource A, finds none, and falls back to
its captured original manager. Distributed transactions across
dataSources remain unsupported.

Tests: 30 unit tests (patches dispatch, idempotency, Q1 Option A
coverage proof, cached-repo invariant) + 11 single-DS integration
+ 8 multi-DS integration against real Postgres via testcontainers.
ADR-018 carries a Phase 14.20 addendum documenting the
architectural addition.

Cross-package consumers (cqrs, outbox-typeorm) and example apps
were migrated mechanically — same `forFeature → forRoot` rename
plus `getDataSourceToken()` provider registration to satisfy the
new DI-resolution contract.

### Future phases (not scheduled)

- **@nestjs-transactional/outbox-prisma**: Prisma persistence backend
  (would slot into Phase 14's adapter contract)
- **@nestjs-transactional/outbox-mongodb**: MongoDB persistence backend
- **OpenTelemetry integration**: tracing across transaction and event
  boundaries
- **ESM dual packaging**: ESM export support

