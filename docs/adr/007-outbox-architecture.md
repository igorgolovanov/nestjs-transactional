# ADR-007: Outbox architecture — split between `outbox-core` and `outbox-typeorm`

## Status

Accepted — 2026-04-24.

## Context

[ADR-006](006-outbox-pattern.md) decides to implement a full
Event Publication Registry equivalent. The implementation needs
to answer one further architectural question: where does the
code live?

Two shapes were under consideration:

1. **One package** that owns both the pattern and a concrete
   persistence backend (TypeORM). Call it
   `@nestjs-transactional/outbox`.

2. **Two packages** — a core with the pattern and an
   `EventPublicationRepository` SPI, plus per-backend packages
   that implement the SPI (`@nestjs-transactional/outbox-typeorm`
   initially, `outbox-prisma` / `outbox-mongodb` / `outbox-kafka`
   later).

The existing shape of the monorepo already follows approach (2)
for transaction management:
`@nestjs-transactional/core` owns the pattern (ports,
`TransactionManager`) and
`@nestjs-transactional/typeorm` owns the TypeORM adapter that
implements the port. Users pick the adapters they need.

## Decision

Split the outbox into two packages, mirroring the existing
core + adapter shape:

- `@nestjs-transactional/outbox-core` — ORM-agnostic. Ships the
  types, lifecycle states, the `EventPublicationRepository` SPI,
  the event publication registry, the listener registry and
  scanner, the `OutboxEventPublisher`, the async
  `EventPublicationProcessor`, the `StalenessMonitor`, the
  `StartupRecoveryService`, the operator-facing APIs
  (`FailedEventPublications`, `IncompleteEventPublications`,
  `CompletedEventPublications`), the `InMemoryEventPublicationRepository`
  for tests, the testing utilities (`PublishedEvents`,
  `AssertablePublishedEvents`), and the NestJS modules
  (`OutboxModule`, `OutboxProcessingModule`). Depends only on
  `@nestjs-transactional/core`.

- `@nestjs-transactional/outbox-typeorm` — TypeORM-backed
  implementation of the SPI. Ships the
  `EventPublicationEntity` + `EventPublicationArchiveEntity`
  with the indexes needed by the worker, the
  `TypeOrmEventPublicationRepository`, the migration (`1700000000000-create-event-publication`)
  and a shared schema-factory used by both the migration and a
  development-time `SchemaInitializer`, plus the
  `OutboxTypeOrmModule` that binds the repository to a
  DataSource. Depends on `outbox-core`, `core`, and `typeorm`.

The split follows the same rules the rest of the monorepo lives
under (CLAUDE.md § "Architectural Principles"):

- `outbox-core` does not import TypeORM or any other ORM.
- `outbox-typeorm` does not import `@nestjs/cqrs`.
- `outbox-core` defines the port (`EventPublicationRepository`);
  adapter packages implement it. Adding a new adapter touches
  exactly one SPI.

## Alternatives considered

**Single `@nestjs-transactional/outbox` package** with TypeORM
baked in. Rejected: forces users to adopt TypeORM to use the
outbox. Adding a future Prisma or MongoDB adapter would require
a major-version cleanup.

**Monolithic per-backend packages** (each shipping its own copy
of the core pattern). Rejected: duplicates the entire lifecycle
machinery, registry, scanner, processor, staleness monitor,
recovery, operator APIs, and testing utilities — none of which
are backend-specific. Drift between backends would be the
default, not the exception.

**Plugin-style architecture** — a single `@nestjs-transactional/outbox`
that accepts backends as runtime plugins (via a factory). This
is what approach (1) degenerates into once you try to support
more than one backend. The two-package split with an SPI is
exactly the same shape, just declared at the module-system level
instead of the runtime-API level. Rejected as unnecessary
indirection.

## Consequences

### Positive

- Adding a new persistence backend is a well-scoped one-package
  PR: implement `EventPublicationRepository`, ship a Nest
  module that binds it to the token, write integration tests.
  No changes required in `outbox-core`.
- Users can use the outbox with any database supported by a
  future adapter. The core package is stable regardless.
- `outbox-core` is testable without Docker — the
  `InMemoryEventPublicationRepository` exercises every code
  path of the SPI.
- The package layout tells the story at a glance. A user who
  reads `packages/` sees exactly what the library knows how to
  talk to.

### Negative

- Two packages instead of one. Users install two deps instead
  of one. Documented via a single `pnpm add …` line in each
  README.
- Peer-dep graph gets slightly more complicated:
  `outbox-typeorm` peer-depends on `@nestjs-transactional/core`,
  `@nestjs-transactional/typeorm`, `@nestjs-transactional/outbox-core`,
  `typeorm`, and `@nestjs/typeorm`. All standard. Release churn
  on `outbox-core` requires a matching `outbox-typeorm` release.
- Two READMEs, two changelogs, two npm pages. Mitigated by
  cross-linking and by the documentation in `docs/architecture/`.

### Neutral

- Extension points are codified. Any future backend
  (`outbox-prisma`, `outbox-mongodb`, `outbox-kafka`) is a new
  package that depends on `outbox-core` and nothing else from the
  persistence side. Kafka externalization in particular is a
  clean fit: it would implement the SPI to write to a Kafka
  topic instead of a SQL table — the registry, processor, and
  operator APIs do not care.

## SPI contract

The `EventPublicationRepository` interface is the contract every
backend implements. The in-memory reference implementation
(`InMemoryEventPublicationRepository` in `outbox-core/testing`)
is both the test double and the executable reference for what
each method must do:

- `createAll(inputs)` — atomic N-row insert, returns the
  persisted records with ids and default fields populated.
- `findById(id)` — by-id lookup or null.
- `updateStatus(id, status, options)` — targeted partial
  update; supports `incrementAttempts` so claim + increment is
  one SQL statement.
- `tryClaim(id)` — atomic conditional update
  (`PUBLISHED|RESUBMITTED → PROCESSING`), returns whether the
  claim won.
- `findReadyForProcessing(limit)` — worker poll. Production
  impls must use `FOR UPDATE SKIP LOCKED` or equivalent.
- `findStale(beforeDate, statuses)` — staleness monitor
  input.
- `findCompleted / findIncomplete / findFailed` — operator
  query APIs.
- `deleteCompleted(olderThan?)` — bulk cleanup.
- `archiveCompleted(id)` — ARCHIVE-mode completion.
- `delete(id)` — DELETE-mode completion.

A backend author implements these ten methods, wires up a
module that binds the implementation to `EVENT_PUBLICATION_REPOSITORY`,
and the rest of the library runs unchanged.

## See also

- [ADR-006 — Outbox pattern rationale](006-outbox-pattern.md)
- [Outbox pattern overview](../architecture/outbox-pattern.md)
- [`@nestjs-transactional/outbox-core` README](../../packages/outbox-core/README.md)
- [`@nestjs-transactional/outbox-typeorm` README](../../packages/outbox-typeorm/README.md)
