# Completed phases — archival list

Per-phase summary of every completed phase. Subset of the
`docs/roadmap/README.md` narrative, kept here for quick scanning
of what's already shipped.

### Completed

- Phase 0: Monorepo setup (pnpm workspaces, TypeScript project references)
- Phase 1: `@nestjs-transactional/core` (all propagation modes, decorators,
  interceptor, method bootstrap, observability)
- Phase 2: `@nestjs-transactional/typeorm` (adapter, helpers,
  multi-datasource)
- Phase 3: `@nestjs-transactional/cqrs` (phase-based dispatching,
  AggregateRoot integration, auto-wrapping)
- Phase 4: Examples and CI/CD (basic, multi-datasource, cqrs-full-stack
  examples; GitHub Actions with lint / build / test)
- Post-Phase-4 technical debt: spec files excluded from publish tarballs,
  provenance configured, coverage reporting in CI
- Phase 5: `@nestjs-transactional/outbox` (alpha) — types, SPI,
  event publication registry, outbox publisher, async processor,
  staleness monitor, startup recovery, operator APIs
  (Failed/Incomplete/Completed), in-memory repo, `OutboxModule` +
  `OutboxProcessingModule`. 143 unit tests.
- Phase 6: `@nestjs-transactional/outbox-typeorm` (alpha) — entities
  (hot + archive), `TypeOrmEventPublicationRepository` with
  `FOR UPDATE SKIP LOCKED`, migration + development-time
  `SchemaInitializer` (shared factory), `OutboxTypeOrmModule` +
  `typeOrmEventPublicationRepositoryProvider`. 20 integration
  tests (Postgres via testcontainers).
- Phase 7: CQRS ↔ outbox integration —
  `OutboxEventPublisher.scheduleForPublication` (sync, per-tx
  buffer via WeakMap<ActiveTransaction, events[]>,
  single beforeCommit flush hook),
  `HybridEventPublisher` with `@Optional()` outbox scheduler via
  `OUTBOX_PUBLICATION_SCHEDULER` structural token,
  `@IntegrationEventsHandler` class-level decorator with the
  dedicated `IntegrationEventsHandlerScanner` that routes to
  outbox/dispatcher based on `OUTBOX_LISTENER_REGISTRAR` binding.
- Phase 8: Testing utilities — `PublishedEvents`,
  `AssertablePublishedEvents`, `PublishedEventsAssertionError`
  exported via `/testing` subpath of outbox. 15 unit tests.
- Phase 9: Documentation & release (Iterations 9.1, 9.2 shipped;
  Iteration 9.3 — release automation — pending under "Next") —
  ADR-006 (outbox rationale), ADR-007 (outbox architecture),
  ADR-014 (class-level handler API), `docs/architecture/outbox-pattern.md`,
  `docs/architecture/outbox-integration-with-cqrs.md`,
  `docs/guides/migrating-to-outbox.md`, `examples/outbox-full-stack/`,
  updated root README with roadmap and outbox packages, updated
  READMEs and migration guide for the class-level handler API.
- Phase 10: Class-level handler API + naming refinement (ADR-014,
  DD-013) — completed in two passes:
  - First pass (Iteration 9.2): migrated all three listener
    decorators from method-level to class-level, matching
    `@nestjs/cqrs` conventions. `@TransactionalEventsListener` →
    `@TransactionalEventsHandler`, `@OutboxEventListener` →
    `@OutboxEventsHandler`, `@ApplicationModuleListener` →
    `@ApplicationModuleHandler`. Listener id format changed from
    `${ClassName}.${methodName}` to `${baseId}#${EventName}`.
    Type-safety enforced via `I*Handler` interfaces. Smart scanner
    replaces the old skip-logic-by-metadata pattern.
  - Second pass (naming refinement): `@ApplicationModuleHandler` →
    `@IntegrationEventsHandler`, `IApplicationModuleHandler` →
    `IIntegrationEventHandler`, `ApplicationModuleHandlerScanner` →
    `IntegrationEventsHandlerScanner`. Rationale: align with
    DDD/microservices terminology; Spring's "Application Module"
    overlaps with NestJS `@Module()` (a DI concept), causing
    confusion. JSDoc carries an explicit Spring Modulith mapping
    note (`@ApplicationModuleListener` → `@IntegrationEventsHandler`).
    Source-code rename completed; documentation rename across
    READMEs / ADR-014 / architecture docs / migration guide /
    examples is absorbed into Phase 11.5.
- Phase 11.0 (preparation): doc updates for event externalization
  — DD-016..19, ADR-015 entry, Phase 11 roadmap.
- Phase 11.1: `EventExternalizer` SPI in `outbox` —
  `ExternalizationMetadata` interface, `EventExternalizer` interface,
  `EVENT_EXTERNALIZER` DI token, `ExternalizationError` extending
  `OutboxError`, optional `@Inject(EVENT_EXTERNALIZER)` injection
  into `EventPublicationProcessor` with `tryExternalize` stub.
- Phase 11.2: `@Externalized` decorator + `ExternalizationRegistry`
  — class-level decorator with typed `<TEvent>` callbacks for
  `routingKey` / `headers`, registry that scans `EventTypeRegistry`
  at module init, `tryExternalize` stub replaced with the real
  resolution + invocation path (DD-019 ordering, `ExternalizationError`
  wrapping). Backward-compat 5-arg `EventPublicationProcessor`
  constructor.
- Phase 11.3: `@nestjs-transactional/outbox-microservices` package —
  `MicroservicesEventExternalizer` over `@nestjs/microservices`
  `ClientProxy`, `OutboxMicroservicesModule.forRoot` /
  `forRootAsync`, reuse of user's `ClientsModule` registration
  (DD-017), bootstrap validation of `defaultClient`, per-event
  `client` override via `@Externalized`. 20 unit + module tests with
  mocked `ClientProxy`.
- Phase 11.4: instead of the originally-planned testcontainers
  integration tests, shipped ADR-016 documenting the silent-success
  reliability limitation discovered in
  `@nestjs/microservices` `ClientProxy.emit()`. Removed the
  testcontainers / kafkajs / amqplib / amqp-connection-manager
  dev-deps and `test:integration` script. Added a
  `microservices-event-externalizer-silent-success.spec.ts` unit
  spec pinning the contract. Prominent README section in
  `outbox-microservices` lists three production mitigation
  strategies. Future broker-aware externalizers can register under
  the same `EVENT_EXTERNALIZER` SPI (DD-018) for stricter
  guarantees.
- Phase 11.5a (documentation pass): ADR-015 (event externalization
  architecture) accepted with a reliability caveat referencing
  ADR-016. `docs/architecture/event-externalization.md` shipped
  with a high-level diagram, end-to-end sequence, failure-mode
  table, reliability semantics section, and Spring Modulith
  mapping. `outbox-microservices` and `outbox` READMEs gained
  cross-links to the new docs. Root README updated: packages list
  includes `outbox-microservices`, roadmap rows for Phase 10 +
  Phase 11, documentation index links the new architecture doc
  and ADR-015 / ADR-016. Deferred Phase B doc-wide rename sweep
  from Iteration 10 completed — `@ApplicationModuleHandler` /
  `IApplicationModuleHandler` / `ApplicationModuleHandlerScanner`
  replaced by `@IntegrationEventsHandler` /
  `IIntegrationEventHandler` /
  `IntegrationEventsHandlerScanner` across READMEs (root,
  cqrs, outbox-typeorm, outbox-full-stack), architecture docs,
  migration guide, and ADR-006. ADR-014 keeps its accepted-text
  body intact and gains a top note pointing at the second-pass
  rename.
- Phase 14.3.1 (bundled scanner + dispatcher per-DS routing): two
  commits closing the four-code-path scanner gap surfaced during
  Phase 14.5–14.7 verification. Audit reframed the fix as Category
  A (outbox-routed scanners with access to per-DS event-type
  registries — auto-resolve owning DS) and Category B (cqrs
  in-memory dispatcher decoupled from outbox — explicit decorator
  `dataSource?` option). Commit 1: `OutboxListenerScanner`
  refactored, new `MultiDsOutboxListenerRegistrar` + cross-package
  `Symbol.for(...)` token sharing for auto-binding cqrs's
  `OUTBOX_LISTENER_REGISTRAR` structural port. Commit 2:
  `dataSource?: string` field on `TransactionalEventsHandlerOptions`
  + `IntegrationEventsHandlerOptions`,
  `TransactionalEventDispatcher.scheduleDispatch` resolves the
  listener's bound DS via
  `TransactionContext.getActiveTransactionByDataSource(dataSource)`
  and pushes hooks directly onto that transaction's hook lists.
  Cross-DS in-memory dispatch now deterministic; manual per-DS
  registry workarounds removed across multi-DS specs and the
  `outbox-full-stack` example. The scanner-gaps entry was removed
  in full from [`docs/known-limitations.md`](../known-limitations.md).
  ADR-018 Phase 14.3.1 addendum.
- Phase 14.21 (OutboxTypeOrmModule reshape): mirrors Phase 14.20
  pattern. `OutboxTypeOrmModule.forFeature` renamed to `forRoot`;
  options shape `{ dataSource?: string }` (DataSource resolved via
  `@nestjs/typeorm`'s `getDataSourceToken`). `forRootAsync` added.
  `typeOrmEventPublicationRepositoryProvider` bridge function
  preserved (architectural finding: removing it would require
  dropping `OutboxModule.forRoot`'s in-memory default and
  migrating 14+ outbox unit tests; trade-off rejected). Phase
  14.12 cleanup bundled — `adapterInstance` deprecated alias and
  `dataSourceName` option field both removed (replaced by unified
  `dataSource` string identifier). Atomicity invariant verified
  end-to-end via dedicated `atomicity.integration.spec.ts` (3
  tests, real Postgres) — two parallel mechanisms (Phase 14.20
  patches on business Repository + outbox repo's explicit
  `getCurrentEntityManager`) converge on the same active EM
  through `TransactionContext`. 34 outbox-typeorm integration
  tests passing. ADR-018 carries Phase 14.21 addendum.
- Phase 14.20 (transparent transactional repositories): three
  prototype patches and per-instance DataSource patches in
  `@nestjs-transactional/typeorm` make `@InjectRepository`
  Repositories, `@InjectEntityManager() em.getRepository(E)`,
  `@InjectDataSource() ds.manager.save(...)`, custom `Repository.extend`
  classes, and `ds.getRepository(E).save(...)` all dispatch
  through the active `@Transactional()` scope automatically.
  Patches install at module-load time (idempotent install-once
  flags) before any DI factory observes `Repository.prototype`.
  `TypeOrmTransactionalModule.forFeature` renamed to `forRoot`
  with `{ dataSource?: string }` shape; DataSource resolved via
  `@nestjs/typeorm`'s `getDataSourceToken`. Two documented
  limitations: `@InjectEntityManager() em.save()` direct call
  NOT transactional (use Repository or
  `getCurrentEntityManager()`); `BaseEntity` static methods NOT
  supported. 30 unit + 11 single-DS + 8 multi-DS integration
  tests against real Postgres. ADR-018 carries the Phase 14.20
  addendum. Cross-package consumers (cqrs, outbox-typeorm,
  examples) migrated mechanically.
- Phase 14.8a (Tier 1 — Foundational examples): four examples
  covering the canonical entry points — `basic-transactional`
  (rewrite of obsolete `basic-usage`, demonstrates Phase 14.20
  transparent repositories), `basic-outbox` (in-memory outbox API
  surface), `basic-typeorm-outbox` (Postgres + atomicity pinned by
  testcontainers integration tests), `basic-cqrs` (Command + Query
  + Events all three handler types). Shipped in 4 commits
  (b38f4b8 + d947632 + ce5bb99 + 3a6082b), 12 tests (9 unit + 3
  integration). New `examples/README.md` top-level index;
  per-tier renovation notes for existing Tier 2+ examples
  (`multi-datasource`, `cqrs-full-stack`, `outbox-full-stack`).
  591/591 package baseline preserved across all four commits.
  Example-library conventions established (standalone jest configs,
  Node16 module resolution для `/testing` subpath imports, root
  `pnpm test` excludes `examples/*`). Convention #14 inscribed —
  Tier 2+ examples ship 1-per-commit.
- Phase 14.8b (Tier 2 — Multi-DataSource examples): four examples
  covering the canonical multi-DS patterns — `multi-datasource-basic`
  (rename + rewrite of obsolete `multi-datasource`, sqljs in-memory,
  no outbox/CQRS), `multi-datasource-outbox` (two physical Postgres
  DBs each with own outbox, Phase 14.3.1 Category A scanner auto-
  routing, smart-facade `OutboxEventPublisher`),
  `multi-datasource-cqrs` (sqljs ×2, `@nestjs/cqrs` with Phase
  14.3.1 Category B `dataSource` decorator option),
  `shared-database-modular-monolith` (Spring Modulith-style: ONE
  Postgres + two schemas, per-domain NestJS sub-modules, per-schema
  outbox stacks). Shipped in 5 commits (34cf35e + 8d1ce01 + 3bd2071
  + 1d0f0e8 + closure), 17 tests (5 unit + 12 testcontainers
  integration). Convention #14 honoured — one example per code
  commit, plus a closure docs commit. 591/591 package baseline
  preserved across all five commits. Two design catches inscribed:
  smart-facade DI requires class-token (not `@InjectOutboxPublisher`),
  and `OutboxModule.forRoot` belongs at AppModule level when
  sub-modules are involved (deterministic scanner-vs-forFeature
  init order). Audit-estimate variance pattern recorded for
  future-tier audits.
- Phase 14.8c (Tier 3 — Externalization examples): four examples
  covering the canonical Phase 11 patterns plus the ADR-016
  reliability story — `externalization-kafka` (single DS + Kafka
  baseline, `@Externalized({ target, routingKey, headers })`,
  docker-compose Kafka KRaft for visual demo), `externalization-multi-broker`
  (Kafka + RabbitMQ + Redis with per-event `@Externalized({ client })`
  routing through single global externalizer),
  `externalization-multi-datasource` (Tier 2 multi-DS combined
  with Tier 3 externalization — two orthogonal axes proven, single
  global externalizer covers both DSes per Phase 14.6 Q1.A),
  `externalization-with-fallback` (the honest example: ADR-016
  silent-success contract pinned + consumer-side inbox/dedup
  template + `FailedEventPublications.resubmit` recovery flow).
  Shipped in 5 commits (4 example commits + closure). 21 tests
  total (0 unit + 21 testcontainers integration), 591/591 package
  baseline preserved across all five commits. Convention #14
  honoured throughout. New code-level pattern surfaced: inbox /
  dedup as the consumer-side complement to the producer outbox,
  `processed-refunds.entity.ts` + `refund-consumer.service.ts` is
  the canonical template. ADR-016 silent-success limit
  demonstrated end-to-end at the framework level (mocked test) and
  manually at the broker level (visual demo with `docker-compose
  stop rabbitmq`). All four examples use class-token DI for
  `OutboxEventPublisher` and reuse user's existing `ClientsModule`
  registration per DD-017.

