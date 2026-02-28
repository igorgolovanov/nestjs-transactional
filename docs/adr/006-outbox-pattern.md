# ADR-006: Outbox pattern — full Spring Modulith Event Publication Registry equivalent

## Status

Accepted — 2026-04-24.

## Context

Through Phase 3 the monorepo's self-described scope was
"Spring Framework-style declarative transaction management for
NestJS", with `@nestjs-transactional/cqrs` providing phase-aware
dispatching (`BEFORE_COMMIT`, `AFTER_COMMIT`, `AFTER_ROLLBACK`,
`AFTER_COMPLETION`) via what was then
`@TransactionalEventsListener` and is now
`@TransactionalEventsHandler` (class-level — see ADR-014).
That covers most of Spring Framework core.
It does **not** cover what Spring Modulith 2.x ships on top:

- A persistent **Event Publication Registry**, so event
  publications commit atomically with business writes.
- **Retry on failure** with operator-facing APIs
  (`FailedEventPublications.resubmit`, etc.).
- **Republish on restart** — unacknowledged publications resume
  on the next process start instead of being silently dropped.
- **Staleness monitoring** — a publication stuck in the
  "worker has claimed it" state flips back into the queue.
- **Completion modes** — `UPDATE` (keep, for audit), `DELETE`
  (space-efficient), `ARCHIVE` (move to cold table).
- **Testing utilities** — `PublishedEvents` and
  `AssertablePublishedEvents` as first-class assertion helpers.
- A composite shortcut decorator — originally planned as
  `@ApplicationModuleListener` and shipped as the class-level
  `@IntegrationEventsHandler` (see ADR-014) — that combines
  "new transaction, after commit, durable" into a single
  annotation.

The gap matters. The classic failure mode that `@Transactional`
is supposed to make impossible — "business data committed,
side-effect never ran" — still exists whenever the side-effect
is wired through an in-memory dispatcher. In-memory semantics
cannot survive a crash between commit and listener invocation.

## Decision

Implement a full Spring-Modulith-equivalent Event Publication
Registry as a first-party feature of the monorepo, split across
new packages:

- `@nestjs-transactional/outbox-core` — types, the
  `EventPublicationRepository` SPI, the listener/publisher
  infrastructure, the async worker, staleness monitor, startup
  recovery, operator APIs, testing utilities, and the NestJS
  module wiring.
- `@nestjs-transactional/outbox-typeorm` — TypeORM-backed
  implementation of the SPI, entities, indexes, migration, and
  a development-time `SchemaInitializer`.

Integration with `@nestjs-transactional/cqrs` lands in the same
scope (Phase 7):

- `HybridEventPublisher` replaces `TransactionalEventPublisher`
  as the default strategy wired into `EventPublisher` by
  `CqrsTransactionalModule`.
- `@IntegrationEventsHandler` is a class-level decorator in
  cqrs — persistent when the outbox registrar is bound,
  in-memory fallback otherwise (see ADR-014 for the shape
  change from a composite-metadata design to a smart scanner).
- `IntegrationEventsHandlerScanner` owns the routing decision,
  so there is no overlap with `TransactionalListenerScanner`
  and no skip-logic is needed.

The repository positioning updates from "Spring Framework
equivalent" to "Spring Modulith equivalent" (see CLAUDE.md).

## Alternatives considered

**Continue as-is** — document the gap, recommend an external
outbox library for production. Rejected: production event-driven
architectures need these guarantees; fragmenting across multiple
libraries produces inconsistent semantics ("does this listener
use my outbox or yours?") and doubles the maintenance surface
for `@nestjs-transactional` users.

**Embed the pattern inside the cqrs package** — one package,
one feature. Rejected: couples persistence concerns to CQRS.
The outbox is valuable outside CQRS (plain command handlers,
REST controllers), and coupling it to CQRS would force users
into CQRS to get durable events.

**Recommend a workflow engine (Temporal, Inngest, …)** —
hand the whole "durable effects" problem off. Rejected: the
scope is wildly different. Workflow engines solve durable
multi-step workflows; the outbox pattern solves "make this
one event delivery atomic with this one transaction". Different
complexity budgets, different integration points, different
deploy models.

**Implement a thin wrapper around an existing Node outbox
library** (e.g. `pg-boss`, `node-transactional-outbox`).
Rejected: the node ecosystem lacks a library whose semantics
match Spring Modulith closely enough to wrap cleanly. Listener
id stability, completion modes, operator APIs, and staleness
monitoring all differ. Implementing the pattern ourselves keeps
the semantic surface under our control and aligned with the
rest of the library.

## Consequences

### Positive

- Production-ready delivery guarantees for event-driven work
  inside the same library that handles transactions. One mental
  model.
- Clear, documented migration path from in-memory
  `@TransactionalEventsHandler` to persistent
  `@OutboxEventsHandler` / `@IntegrationEventsHandler`. See
  `docs/guides/migrating-to-outbox.md`.
- Feature parity with Spring Modulith for users coming from the
  JVM. Same mental model, same operator tools, same testing
  API shapes.
- Extension points for future persistence backends
  (outbox-prisma, outbox-mongodb) and transports
  (outbox-kafka, outbox-rabbitmq). Adding a new backend requires
  implementing one SPI and shipping a module; the rest of the
  machinery reuses.

### Negative

- ~3 weeks of incremental work (Phase 5 through Phase 9) before
  any user sees the feature in a release. Spread across 30+
  iterations, tracked in CLAUDE.md's Phase sections.
- Two new packages to maintain, release, and document. Each
  release event now touches four to five packages instead of
  three.
- The public API surface of the monorepo grows. `OutboxModule`,
  `OutboxTypeOrmModule`, `@OutboxEventsHandler`,
  `@IntegrationEventsHandler`, `PublishedEvents`,
  `AssertablePublishedEvents`, completion modes, etc. — more
  things to keep stable under the 0.x → 1.0 progression and to
  document.
- Users who were happy with in-memory phase-aware handlers now
  have to make an explicit decision — "do I want the outbox?" —
  when wiring their application. `@IntegrationEventsHandler`
  is designed to defer that decision: write the decorator,
  enable the outbox later by a single wiring change.

### Neutral

- The scope statement in `CLAUDE.md` rewrites from
  "Spring Framework" to "Spring Modulith". The library is no
  longer "just `@Transactional`"; it is "the Spring-equivalent
  transactional + event-delivery infrastructure for NestJS".

## See also

- [Outbox pattern overview](../architecture/outbox-pattern.md)
- [ADR-007 — Outbox architecture (core + typeorm split)](007-outbox-architecture.md)
- [Spring Modulith — Event Publication Registry](https://docs.spring.io/spring-modulith/reference/events.html)
