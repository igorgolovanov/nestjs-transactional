# @nestjs-transactional monorepo

## Overview

This repository aims to deliver Spring Modulith-equivalent transaction and
event-delivery infrastructure for NestJS applications, split across a
growing set of npm packages organised by concern.

### Current (published / in-tree)

- **@nestjs-transactional/core** — base infrastructure: AsyncLocalStorage
  context, TransactionManager with propagation modes, `@Transactional()`
  decorator, adapter port interfaces. No dependency on any concrete ORM.
- **@nestjs-transactional/typeorm** — TypeORM adapter, helper for retrieving
  the active EntityManager from the current async context, integration with
  `@nestjs/typeorm`.
- **@nestjs-transactional/cqrs** — integration with `@nestjs/cqrs`: runtime
  wrappers for CommandHandler/QueryHandler/EventHandler, class-level
  `@TransactionalEventsHandler` with Spring-like phases, `HybridEventPublisher`
  + `@IntegrationEventsHandler`, EventPublisher override for AggregateRoot.
- **@nestjs-transactional/outbox** *(alpha)* — persistent Event Publication
  Registry: lifecycle states, repository SPI, async worker, staleness
  monitor, startup recovery, operator APIs (Failed/Incomplete/Completed),
  testing utilities. ORM-agnostic.
- **@nestjs-transactional/outbox-typeorm** *(alpha)* — TypeORM persistence
  backend for the outbox: `event_publication` + archive entities,
  `TypeOrmEventPublicationRepository` with `FOR UPDATE SKIP LOCKED`,
  shipped migration, `OutboxTypeOrmModule` wiring.
- **@nestjs-transactional/outbox-microservices** *(alpha)* — event
  externalization to brokers (Kafka, RabbitMQ, NATS, JMS, gRPC, ...) via
  `@nestjs/microservices` `ClientProxy`. One package covers every transport
  the upstream supports. Reliability caveat: see ADR-016.

### Future (not scheduled)

- **@nestjs-transactional/outbox-prisma** — Prisma persistence backend
- **@nestjs-transactional/outbox-mongodb** — MongoDB persistence backend
- **@nestjs-transactional/testing** — integration testing utilities
  cross-cutting over core / typeorm / cqrs / outbox

## Mission Statement

Give NestJS applications transaction management on par with Spring
Framework: a declarative `@Transactional`, the full set of propagation
modes, support for multiple DataSources in the same app, and a tight
integration with event-driven paradigms through CQRS with phase-aware
listeners. See [docs/architecture/spring-modulith-parity.md](docs/architecture/spring-modulith-parity.md)
for the explicit scope-coverage matrix and Spring-Modulith mapping.

## Technology Stack

- **Runtime**: Node.js 22 LTS (minimum); 22 / 24 / 26 verified in CI
- **Language**: TypeScript 5.5+ in strict mode
- **Core peer deps**: `@nestjs/common ^10.0.0 || ^11.0.0`,
  `@nestjs/core ^10.0.0 || ^11.0.0`, `reflect-metadata`, `rxjs ^7.0.0`
- **TypeORM peer**: `typeorm ^0.3.25`, `@nestjs/typeorm ^10.0.0 || ^11.0.0`
- **CQRS peer**: `@nestjs/cqrs ^11.0.0`
- **Package manager**: pnpm workspaces
- **Build**: tsc with project references (no bundler — pure TypeScript)
- **Test runner**: Jest + ts-jest
- **Integration tests**: testcontainers-node for a real Postgres
- **Versioning**: Changesets
- **License**: MIT

## Map of the docs

Everything substantive that used to live inside this file has been
extracted into `docs/`. CLAUDE.md is now the *session-onboarding
context* for AI agents — keep it short and high-signal; consult
the linked docs for depth.

| Topic | Where |
|---|---|
| Architectural principles | [docs/architecture/principles.md](docs/architecture/principles.md) |
| Spring Modulith parity goal + scope coverage | [docs/architecture/spring-modulith-parity.md](docs/architecture/spring-modulith-parity.md) |
| Monorepo structure (file tree) | [docs/architecture/monorepo-structure.md](docs/architecture/monorepo-structure.md) |
| Per-package architecture deep-dives | [docs/architecture/](docs/architecture/) — `core-design.md`, `outbox-pattern.md`, `outbox-integration-with-cqrs.md`, `event-externalization.md` |
| Architecture Decision Records | [docs/adr/](docs/adr/) — see ADR index below |
| Design Decisions | [docs/dd/](docs/dd/) — see DD index below |
| Implementation roadmap (per phase) | [docs/roadmap/README.md](docs/roadmap/README.md) |
| Empirically-discovered conventions | [docs/status/conventions.md](docs/status/conventions.md) |
| Coding conventions, testing strategy, dev workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Multi-adapter migration guide | [docs/migration/multi-adapter.md](docs/migration/multi-adapter.md) |
| Migrating to outbox (user-facing) | [docs/guides/migrating-to-outbox.md](docs/guides/migrating-to-outbox.md) |
| Known limitations | [docs/known-limitations.md](docs/known-limitations.md) |
| Per-package public API + usage | each package's `README.md` |
| Example library | [examples/README.md](examples/README.md) |

## Architecture Decision Records

Formal records for architectural decisions that need more room than
the Design Decisions list below.

- **ADR-001**: AsyncLocalStorage foundation — [`docs/adr/001-async-local-storage.md`](docs/adr/001-async-local-storage.md)
- **ADR-002**: Transactional events with Spring semantics — [`docs/adr/002-transactional-events-spring-semantics.md`](docs/adr/002-transactional-events-spring-semantics.md)
- **ADR-003**: Not patching @nestjs/cqrs — [`docs/adr/003-not-patching-nestjs-cqrs.md`](docs/adr/003-not-patching-nestjs-cqrs.md)
- **ADR-004**: Public API stability policy — [`docs/adr/004-public-api-stability.md`](docs/adr/004-public-api-stability.md)
- **ADR-005**: Method wrapping strategy — [`docs/adr/005-method-wrapping-strategy.md`](docs/adr/005-method-wrapping-strategy.md)
- **ADR-006**: Outbox pattern rationale — [`docs/adr/006-outbox-pattern.md`](docs/adr/006-outbox-pattern.md)
- **ADR-007**: Outbox architecture (core + typeorm split) — [`docs/adr/007-outbox-architecture.md`](docs/adr/007-outbox-architecture.md)
- **ADR-008**: Event serialization strategy — [`docs/adr/008-event-serialization.md`](docs/adr/008-event-serialization.md)
- **ADR-009**: Listener ID stability — [`docs/adr/009-listener-id-stability.md`](docs/adr/009-listener-id-stability.md)
- **ADR-014**: Class-level handler API redesign — [`docs/adr/014-handler-api-redesign.md`](docs/adr/014-handler-api-redesign.md)
- **ADR-015**: Event externalization architecture — [`docs/adr/015-event-externalization-architecture.md`](docs/adr/015-event-externalization-architecture.md)
- **ADR-016**: Externalization reliability semantics — [`docs/adr/016-externalization-reliability-semantics.md`](docs/adr/016-externalization-reliability-semantics.md)
- **ADR-018**: Multi-adapter architecture — [`docs/adr/018-multi-adapter-architecture.md`](docs/adr/018-multi-adapter-architecture.md)
- **ADR-019**: OutboxModule multi-`forRoot` registration pattern — [`docs/adr/019-outbox-multi-forroot-pattern.md`](docs/adr/019-outbox-multi-forroot-pattern.md)

Superseded / Skipped (number reserved, not reused):

- **ADR-010** — Hybrid event publishing — superseded by ADR-014.
  Pointer stub at [`docs/adr/010-hybrid-event-publishing.md`](docs/adr/010-hybrid-event-publishing.md).
- **ADR-011 / ADR-012 / ADR-013** — Skipped (Phase 8/9 reserve).
  Stubs at [`docs/adr/011-skipped.md`](docs/adr/011-skipped.md),
  [`docs/adr/012-skipped.md`](docs/adr/012-skipped.md),
  [`docs/adr/013-skipped.md`](docs/adr/013-skipped.md).
- **ADR-017** — Skipped (Phase 12/13 reserve). Stub at
  [`docs/adr/017-skipped.md`](docs/adr/017-skipped.md).

ADR numbers are monotonic and never reused. An accepted ADR can only
be changed by a new ADR that references it with `supersedes NNN`.

## Design Decisions

DDs capture decisions taken during phase iterations that don't carry
enough architectural weight for an ADR. Each DD lives in its own file
under [`docs/dd/`](docs/dd/); this is the index. Many DDs cross-reference
an ADR — the cross-link is on the DD's own page.

- [DD-001](docs/dd/001-async-local-storage.md) — AsyncLocalStorage as the foundation
- [DD-002](docs/dd/002-no-fork-nestjs-cqrs.md) — We do not fork @nestjs/cqrs
- [DD-003](docs/dd/003-one-package-one-responsibility.md) — One package, one responsibility
- [DD-004](docs/dd/004-adapter-as-interface.md) — Adapter as interface, not base class
- [DD-005](docs/dd/005-multi-datasource-first-class.md) — Multi-DataSource as a first-class feature
- [DD-006](docs/dd/006-jest-over-vitest.md) — Jest over Vitest
- [DD-007](docs/dd/007-legacy-decorators.md) — Legacy decorators + reflect-metadata
- [DD-008](docs/dd/008-method-wrapping-triad.md) — Method wrapping via a triad of mechanisms
- [DD-009](docs/dd/009-event-publication-registry.md) — Implement full Event Publication Registry
- [DD-010](docs/dd/010-outbox-core-persistence-split.md) — Split outbox into core + persistence packages
- [DD-011](docs/dd/011-hybrid-event-publishing.md) — Hybrid event publishing
- [DD-012](docs/dd/012-integration-events-handler.md) — `@IntegrationEventsHandler` as smart default
- [DD-013](docs/dd/013-class-level-handler-api.md) — Class-level handler API
- [DD-014](docs/dd/014-skipped.md), [DD-015](docs/dd/015-skipped.md) — Skipped (Phase 9/10 reserve)
- [DD-016](docs/dd/016-event-externalization.md) — Implement event externalization
- [DD-017](docs/dd/017-reuse-clients-module.md) — Reuse `ClientsModule` for `ClientProxy` registration
- [DD-018](docs/dd/018-event-externalizer-spi.md) — `EventExternalizer` SPI as a structural port
- [DD-019](docs/dd/019-hybrid-delivery-atomicity.md) — Atomicity unit and execution order for hybrid delivery
- [DD-020](docs/dd/020-multi-adapter-datasource-name.md) — Multi-adapter through dataSource-name identifier
- [DD-021](docs/dd/021-adapter-constructor-datasource.md) — Adapter constructor accepts dataSource name
- [DD-022](docs/dd/022-inject-decorators-datasource.md) — Inject decorators accept a dataSource parameter
- [DD-023](docs/dd/023-independent-tx-contexts-per-ds.md) — Independent transaction contexts per dataSource
- [DD-024](docs/dd/024-outbox-publisher-facade.md) — Smart `OutboxEventPublisher` facade

## DO NOT cheat-sheet

The most-violated rules. Full coding conventions in
[CONTRIBUTING.md](CONTRIBUTING.md).

- **DO NOT use `any`** without `@ts-expect-error` and a comment.
- **DO NOT change public interfaces** without a changeset.
- **DO NOT throw generic Error** — only specific classes inheriting
  from `TransactionError`.
- **DO NOT use console.log/warn/error in production paths** — use
  the NestJS Logger.
- **DO NOT wrap a method directly inside a decorator** — decorators
  only write metadata; wrapping is done at bootstrap (see ADR-005).
- **DO NOT use TC39 stage-3 decorator syntax** — the whole ecosystem
  is on legacy + reflect-metadata (see DD-007).
- **DO NOT publish events outside a transaction via
  `OutboxEventPublisher`** — that breaks single-unit atomicity
  (DD-019). Publish inside a `@Transactional` method.
- **DO NOT rename handler classes carelessly once the outbox is in
  use** — the class name is part of the listener id. Pin a stable
  id via `@OutboxEventsHandler({ events: [...], id: '...' })` (see
  ADR-009).
- **DO NOT write separate classes for `@TransactionalEventsHandler`
  and `@OutboxEventsHandler` on the same event** — use
  `@IntegrationEventsHandler` (the smart default) or commit to one.
- **DO NOT apply the `event_publication` schema in production
  without a migration** — auto schema initialization is
  development-only.
- **DO NOT use dynamic `require()` for optional cross-package
  dependencies** — use a DI token (structural port) with
  `@Optional()`. Bundlers (webpack, esbuild, Vite) break on dynamic
  require.
- **DO NOT register `ClientProxy` instances inside
  `OutboxMicroservicesModule`** — reuse the user's existing
  `ClientsModule` registration via `defaultClient` (DD-017).
- **DO NOT import `CqrsModule` directly alongside
  `CqrsTransactionalModule.forRoot()`** — the override of
  `EventPublisher` gets shadowed; aggregate events bypass the
  dispatcher. See `docs/status/conventions.md` Convention #6.
- **DO NOT use `@InjectOutboxPublisher` in multi-DS services** —
  that decorator binds the per-DS publisher and bypasses smart-
  facade routing (DD-024). Use class-token DI
  (`private readonly outbox: OutboxEventPublisher`).

## Quality Gates

Before merging into main:

- [ ] All tests green (`pnpm -r test`)
- [ ] Integration tests green (`pnpm -r test:integration`)
- [ ] Build with no warnings (`pnpm -r build`)
- [ ] Lint clean (`pnpm -r lint`)
- [ ] Coverage has not dropped below baseline
- [ ] Changeset added (for user-facing changes)
- [ ] README / docs updated when the public API changed
- [ ] ADR added for significant architectural decisions

## Session Onboarding for Claude Code

When starting a new session:

1. Read this CLAUDE.md in full.
2. Skim the [Map of the docs](#map-of-the-docs) above. Open the
   linked file for any topic the user's request touches; do not
   guess from memory.
3. Check the current state under [Current Status](#current-status)
   below — the most-recent phase summary lives there. The full
   phase-by-phase narrative is in
   [`docs/roadmap/README.md`](docs/roadmap/README.md).
4. Confirm your understanding with the user before starting work.
5. If anything is unclear — ask before writing code.

While working:

1. **Tests-first**: tests first (describing the behavior), then
   implementation.
2. **Small iterations**: run tests and linter after each meaningful
   step.
3. **Check constraints**: you are not crossing dependency boundaries
   (core knows nothing about typeorm, etc.).
4. **Update docs**: if the public API changed, update the README
   and JSDoc.
5. **Ask when uncertain**: better to ask than to guess.
6. **Language**: all committed text in the repo is English. Chat
   with the user is Russian unless they switch.

If the task requires an architectural decision not described in
the docs — **stop and discuss** with the user. It may become an ADR.

## Current Status

**Last update**: Phase 14.8f comprehensive documentation sweep
shipped (5 commits) — closes Phase 14.8 Tier 1–5 example library
and the multi-adapter era documentation. Per-package READMEs
synced with the example catalogue and Phase 14.20/14.21 alignment;
pre-tier `cqrs-full-stack` and `outbox-full-stack` examples retired;
ADR-018 / ADR-019 collapsed running addendum history into final-form
Decision prose; `docs/guides/migrating-to-outbox.md` fully rewritten
with multi-DataSource and externalization sections;
[`docs/roadmap/README.md`](docs/roadmap/README.md) restructured
into an era-based narrative with Phase 14 sub-phases in numerical
order. The phase-by-phase narrative is the canonical source for
historical context.

### Blocked / Awaiting

- Pre-0.1.0 release blockers: Docker integration tests in CI,
  NPM_TOKEN setup, first changeset for outbox packages.

### Next

- **Phase 9 iteration 9.3** (release automation): changeset
  entries for the outbox packages, CI matrix tweaks for Docker
  integration tests, NPM_TOKEN setup, and the first 0.1.0-alpha
  release. Independent track — does not block further iterations
  on the framework itself.
- Future phases (not scheduled): broker-aware externalizers
  (native `kafkajs` / `amqplib` / `nats`), outbox-prisma,
  outbox-mongodb, OpenTelemetry integration, ESM dual packaging.

### Five most recent decisions

- Phase 14.8f shipped — comprehensive documentation sweep closing
  the multi-adapter era. Five commits: per-package READMEs synced
  with the example catalogue + Phase 14.20/14.21 alignment;
  pre-tier `cqrs-full-stack` and `outbox-full-stack` examples
  retired (coverage absorbed by `basic-cqrs`, `basic-typeorm-outbox`,
  Tier 5 `e-commerce-orders`); ADR-018 / ADR-019 deep rewrite
  collapsed running addendum history into final-form Decision
  prose; `docs/guides/migrating-to-outbox.md` fully rewritten with
  multi-DataSource and externalization sections;
  `docs/roadmap/README.md` restructured into era-based narrative
  with Phase 14 sub-phases in numerical order. Net delta:
  +1612 / -2295 LoC (doc corpus contracted thanks to addendum
  collapse and pre-tier example retirement). Date-discipline rule
  inscribed mid-flight: ADR `**Date**:` header is convention,
  inline body and Revision-history bullet dates avoided in favour
  of phase anchors.
- Framework fix landed for Convention #22 (follow-up to Phase 14.8e
  closure) — `TypeOrmTransactionalModule.forRootAsync` registration
  moved from a `useFactory` provider to an `OnModuleInit`-driven
  `@Injectable()` class generated per `forRootAsync` call. Root
  cause was `markAsManaged(undefined)` cascading from
  `moduleRef.get`/`resolve` returning `undefined` while
  `@nestjs/typeorm`'s async DataSource provider was still pending.
  Pinned by
  `packages/typeorm/test/integration/forrootasync.integration.spec.ts`.
  The async-config example reverted its workaround and now uses
  `forRootAsync` for all four framework modules.
- Phase 14.8e shipped — Tier 5 production-realism examples
  (`e-commerce-orders` flagship 3-DS saga + Kafka + CQRS + REST;
  `async-config-from-environment` `forRootAsync` end-to-end with
  Joi + .env profiles; `graceful-shutdown` outbox drain +
  lifecycle hooks). Seven new conventions: #18 inner-method
  indirection for `@Transactional` inside `@IntegrationEventsHandler`;
  #19 `@Externalized` events still need a local
  `@OutboxEventsHandler` to materialise a publication;
  #20 `CqrsTransactionalModule` does not export `CommandBus` /
  `QueryBus` (controllers inject handlers directly);
  #21 `OutboxModule.forRootAsync({ repository })` lives on options,
  not on the async factory result; #22 historical record of the
  `TypeOrmTransactionalModule.forRootAsync` bug (now fixed — see
  decision above); #23 dotenv refuses to overwrite `process.env`
  (snapshot/restore between tests); #24 user-side
  `OutboxDrainService` complement to the framework's sync
  `OutboxProcessingModule.onApplicationShutdown`. LoC envelope
  updated for flagship multi-multi-axis examples (1800–2100 floor).
- Phase 14.8d shipped — Tier 4 advanced-pattern examples (saga
  with compensation; cross-DS audit through outbox; master/replica
  read-write-separation; meta-example with three test tiers).
  Three new conventions (#15 silent-no-op publish without listener;
  #16 `@TransactionalEventsHandler` does not receive
  `OutboxEventPublisher.publish` events; #17 `Node16` module
  resolution required for subpath imports).
- Phase 14.8c shipped — ADR-016 silent-success limitation pinned
  by the externalization example library; consumer-side
  inbox/dedup pattern inscribed as code template; three Tier 3
  examples use class-token `OutboxEventPublisher` DI for smart-
  facade routing; one global externalizer per process (per-broker
  routing via `@Externalized({ client })`).

For the full phase-by-phase narrative see
[`docs/roadmap/README.md`](docs/roadmap/README.md). For
empirically-discovered conventions surfaced during implementation
see [`docs/status/conventions.md`](docs/status/conventions.md).
