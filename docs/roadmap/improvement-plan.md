# Improvement Plan — Path to Stable 1.0.0

**Status**: accepted — scheduled workstreams A–C; workstream D deferred
**Anchor**: post-alpha assessment (packages published at `1.0.0-alpha.x`)

A full-project assessment performed after the first public alpha
shipped, and the prioritised plan derived from it. Priorities chosen
for the next iterations: **(1) API consistency for a stable `1.0.0`**
and **(2) production readiness of the outbox stack**. Infrastructure
and ecosystem findings are recorded as a deferred backlog.

Each item below carries file anchors and a definition of done (DoD).
Items marked *needs DD/ADR* involve an architectural decision that
must be discussed before implementation and recorded under
[`docs/dd/`](../dd/) or [`docs/adr/`](../adr/).

## Assessment snapshot

**Strengths.** Strict TypeScript throughout (`strict`,
`noUncheckedIndexedAccess`, `useUnknownInCatchVariables`); all seven
Spring propagation modes genuinely implemented, including `NESTED`
via savepoints and `rollbackFor`/`noRollbackFor` with Spring
precedence; clean `TransactionError` hierarchy with stable `code`
fields; no skipped/focused tests anywhere; no TODO/FIXME debt
(limitations live in ADRs, not inline comments); spec-to-source LoC
ratio above 1:1 in `core` and `cqrs`; real-Postgres integration
suites via testcontainers in `typeorm` and `outbox-typeorm`; a rich
docs corpus (20 ADRs, 24 DDs, tiered example library).

**Gap groups.**

| Group | Theme | Scheduled? |
|---|---|---|
| A | Public API promises the implementation does not keep | yes |
| B | No coverage governance (thresholds, CI reporting) | yes |
| C | Outbox operational gaps (shutdown, retry, observability) | yes |
| D | Infrastructure / ecosystem (CI breadth, ESM, community files) | deferred |

## Workstream A — API consistency for 1.0.0

### A1. `readOnly` and `timeout` are declared but silently ignored — *needs DD/ADR*

*Stopgap shipped:* the JSDoc on both options, on `@ReadOnly`, and on
the cqrs module's `defaultQueryOptions` default now states that
nothing enforces them, and
[`known-limitations.md`](../known-limitations.md) carries a dedicated
entry. The implement-or-deprecate decision below is still open.

`TransactionOptions.readOnly` and `TransactionOptions.timeout`
(`packages/core/src/types/transaction-options.ts`) carry confident
JSDoc, and the only shipped adapter drops both —
`TypeOrmTransactionAdapter` (`packages/typeorm/src/adapter/typeorm.adapter.ts`)
forwards only `isolation`. The no-ops flow through the `@ReadOnly`
decorator and `CqrsTransactionalModule`'s
`defaultQueryOptions: { readOnly: true }`, giving users a false sense
of enforcement. Not mentioned in
[`docs/known-limitations.md`](../known-limitations.md).

Recommended direction (to be confirmed in the DD): implement
`readOnly` in the TypeORM adapter (`SET TRANSACTION READ ONLY` on
Postgres-family dialects); for `timeout` either implement via
dialect-specific statement timeouts or explicitly document it as
unsupported per adapter.

**DoD**: every `TransactionOptions` field is either honoured by the
adapter or documented as a per-adapter limitation in
`known-limitations.md` and in the option's JSDoc; behaviour pinned by
integration tests.

### A2. `CqrsTransactionalModule` lacks `forRootAsync`

Core and typeorm modules expose `forRootAsync`; the cqrs module only
has `forRoot` (`packages/cqrs/src/module/cqrs-transactional.module.ts`).
The wrapper infrastructure already supports async option provision
(`CQRS_HANDLER_WRAPPER_OPTIONS`), so this is an omission, not a
design constraint. While there, remove the
`exports: exportTokens as never[]` cast — a type smell on a public
module.

**DoD**: `forRootAsync` with parity to the typeorm module's option
surface; `never[]` cast replaced with a properly typed exports array;
covered by module specs; README example added.

### A3. `@nestjs/cqrs` peer range narrower than the rest of the repo

`packages/cqrs/package.json` pins `@nestjs/cqrs: "^11.0.0"` while
every other NestJS peer is `"^10.0.0 || ^11.0.0"`. Either widen the
range (verifying against `@nestjs/cqrs@10` internals the wrapper
touches) or record the rationale for the narrower range in the
package README.

**DoD**: peer range widened and CI-verified, or the constraint
documented; changeset included.

### A4. Stale JSDoc references a non-existent `TypeOrmTransactionalModule.forFeature` — *shipped*

The `CqrsTransactionalModule` module JSDoc and `@example` instructed
users to call `TypeOrmTransactionalModule.forFeature({ dataSource })`;
that method does not exist (only `forRoot` / `forRootAsync`).

Fixing it surfaced a worse defect in the same `@example`: it imported
`@nestjs/cqrs`'s `CqrsModule` alongside
`CqrsTransactionalModule.forRoot()` — the double-import that shadows
the `EventPublisher` override and silently routes aggregate events
around the dispatcher (convention #6). It was the only place in the
repository still showing the forbidden pattern, and it shipped in the
`.d.ts`. Both are corrected.

### A5. `ResubmissionOptions.maxInFlight` is a dead option

`ResubmissionOptions` (`packages/outbox/src/types/resubmission-options.ts`)
exposes `withMaxInFlight()` and a `maxInFlight` getter, but
`FailedEventPublications.resubmit()`
(`packages/outbox/src/api/failed-event-publications.ts`) never reads
it — only `batchSize`, `minAge`, `maxCompletionAttempts`, and
`filter` are honoured.

**DoD**: `maxInFlight` either implemented in `resubmit()` or removed
from the options type (breaking change → changeset), with tests
either way.

### A6. TypeORM patching layer has no contract tests

`packages/typeorm/src/patching/*` concentrates ~54 `any` usages and
reaches into un-exported TypeORM internals
(`DataSource` / `Repository` / `EntityManager` prototypes). A
`typeorm` version bump can break it silently. The CI matrix already
exercises typeorm `0.3` and `1.0`, but there is no focused contract
suite asserting the internal shapes the patches rely on.

**DoD**: a contract spec per patched surface that fails loudly (with
a pointed message) when a TypeORM internal the patch depends on
changes shape; runs in the existing version matrix.

### A7. `runInSavepoint` never signals unsupported savepoints

The `TransactionAdapter` contract
(`packages/core/src/types/transaction-adapter.ts`) prescribes
`IllegalTransactionStateError` when savepoints are unsupported;
`TypeOrmTransactionAdapter.runInSavepoint` cannot throw it. Fine for
SQL dialects, but a latent contract mismatch future adapters will
copy.

**DoD**: adapter contract clarified (JSDoc) and, if feasible, a
capability check added; core's adapter-contract test template updated
so future adapters inherit the expectation.

### A8. Docs claim `FOR UPDATE SKIP LOCKED` the code deliberately dropped — *shipped*

Corrected in the root README, `packages/outbox-typeorm/README.md`,
[`outbox-pattern.md`](../architecture/outbox-pattern.md),
[`migrating-to-outbox.md`](../guides/migrating-to-outbox.md),
`AGENTS.md`, and two example READMEs.

The tail turned out to be the substantive half. The same claim was
normative in two contract locations — the
`EventPublicationRepository` JSDoc (which ships in the `.d.ts` that
backend authors read) and [ADR-007](../adr/007-outbox-architecture.md)'s
`SPI contract` appendix — and the interface contradicted itself about
whether the poll or `tryClaim` provided the concurrency guarantee.
Neither shipped implementation locked rows, including the in-memory
one ADR-007 calls the executable reference. Resolved by
[DD-025](../dd/025-claim-atomicity-obligation.md), which puts the
atomicity obligation on `tryClaim` and declares the poll explicitly
non-exclusive; ADR-007's appendix is corrected inline with an
amendment note (its Decision — the package split — was never in
question).

Original finding:

Root `README.md` (package table and outbox section) advertises
`FOR UPDATE SKIP LOCKED`, but
`TypeOrmEventPublicationRepository`
(`packages/outbox-typeorm/src/repository/`) deliberately abandoned it
in favour of the atomic conditional-`UPDATE` `tryClaim` (the code
documents the race and the 1–3 worker sweet spot). Doc drift on a
load-bearing concurrency claim.

**DoD**: README (root + `packages/outbox-typeorm`) describes the
actual claim mechanism and its concurrency envelope.

## Workstream B — Test and coverage governance — *shipped*

B1, B2 and B3 landed together: removing `passWithNoTests` breaks the
one package that had no unit tests, so the gate and the tests it
exposes could not be separated.

### B1. No coverage thresholds; `passWithNoTests: true` — *shipped*

`jest.config.base.js` set `passWithNoTests: true` and defined no
`coverageThreshold`, so a package with zero tests passed silently —
`outbox-typeorm` did exactly that, printing
`No tests found, exiting with code 0`.

`passWithNoTests` is gone, and every package declares a
`coverageThreshold` in its own `jest.config.js`, set from measured
coverage at the time the gate was introduced:

| Package | statements | branches | functions | lines |
|---|---|---|---|---|
| core | 95 | 85 | 97 | 96 |
| cqrs | 95 | 90 | 92 | 95 |
| outbox | 95 | 85 | 93 | 95 |
| typeorm | 90 | 62 | 90 | 90 |
| outbox-microservices | 97 | 65 | 100 | 97 |
| outbox-typeorm | 60 | 20 | 40 | 59 |

They are floors, not targets, and are documented as ratcheting in
[CONTRIBUTING.md](../../CONTRIBUTING.md). Both failure modes were
negative-tested: a violated threshold and a package with no matching
tests each exit non-zero.

Branches are the weak axis and the honest next target — `typeorm`
(62) and `outbox-microservices` (65) sit well below their statement
coverage. `outbox-typeorm`'s low floors are dominated by
`src/module/` (436 LoC), which is covered by the testcontainers suite
rather than the unit suite; migrations are excluded from unit
coverage since TypeORM's own runner executes them and the integration
suite verifies the result.

### B2. CI never measures coverage — *shipped*

A `coverage` job runs `pnpm -r --filter './packages/*' test:cov` on a
single cell (Node 22 / TypeORM 0.3 — coverage does not vary by
runtime version, and the `test` job already spans the full matrix)
and uploads `packages/*/coverage/lcov.info` as an artifact. This is
the enforcement behind the "coverage has not dropped below baseline"
quality gate, which was previously unverifiable.

No coverage service is wired up; the artifact is the deliverable. A
Codecov-style integration remains optional.

### B3. `outbox-typeorm` has zero unit tests — *shipped*

21 Docker-free specs added under `packages/outbox-typeorm/test/unit/`,
scoped to logic that does not need a database — the integration suite
keeps proving the SQL:

- **The DD-025 claim contract**: `tryClaim` translating TypeORM's
  `affected` count into won/lost, including that a `null` or
  `undefined` count reads as *lost*. Reading it as success would let
  every worker dispatch the same publication. Mutation-checked — the
  three cases fail if the `?? 0` guard is removed.
- **`SchemaInitializer`**: auto-init off by default (the
  production-safety rule from the DO NOT cheat-sheet), no database
  probe at all when disabled, existing schema left untouched, and the
  query runner released even when DDL throws — a leaked runner turns
  a one-off DDL error into an app that cannot serve traffic.
- Guard branches and mapping: `findStale([])` short-circuiting
  without a query, `deleteCompleted` reporting 0 for an absent
  affected count, `archiveCompleted` raising
  `PublicationNotFoundError` and stamping a completion date, and
  nullable lifecycle fields surviving entity → domain mapping.

Deliberately **not** covered by mocks: the query-builder call shapes
of `findCompleted` / `findIncomplete` / `findFailed`. Asserting those
against a mocked `EntityManager` pins mock structure rather than
behaviour; the integration suite already runs the real SQL.

No new dependencies were added. `sql.js` (which `typeorm`'s unit
suite uses) would have allowed a real in-memory database instead of a
mocked `EntityManager`, but the outbox entities use Postgres-specific
`timestamptz` columns, and adding a dependency needs sign-off.

## Workstream C — Outbox production readiness

### C1. Graceful shutdown does not drain in-flight work — *shipped*

`EventPublicationProcessor.stop()` and `StalenessMonitor.stop()` are
`async` and await the work already in flight; the module hook awaits
all of them concurrently, so multi-dataSource deployments do not add
up their budgets. An idle worker resolves immediately — the drain
costs nothing when there is nothing to drain.

`processor.shutdownTimeout` and `staleness.shutdownTimeout` bound the
wait (default `DEFAULT_DRAIN_TIMEOUT_MS`, 10 s; `0` restores the old
no-wait behaviour). Work abandoned at the deadline is abandoned, not
cancelled — there is no safe way to interrupt a half-finished listener
invocation — so the trade-off is shutdown latency against recovery
lag, never durability.

Convention #24 is rewritten as a historical record and the example's
`OutboxDrainService` is deleted. Pinned at two levels: unit specs for
the drain, the timeout, the `0` case and idempotency, and the
`graceful-shutdown` integration suite against real Postgres. Both were
mutation-checked — removing the drain fails the unit specs, and
setting `shutdownTimeout: 0` fails the integration test that asserts
an in-flight handler completes before teardown.

Not addressed here: `StartupRecoveryService` has no in-flight work to
drain (it runs once at bootstrap), so it needed no change.

Original finding:

`OutboxProcessingModule.onApplicationShutdown()`
(`packages/outbox/src/module/outbox-processing.module.ts`) is
synchronous and `EventPublicationProcessor.stop()` only clears the
pending timer — an in-flight `processBatch()` is not awaited, so
shutdown can strand rows in `PROCESSING` (recoverable only via
staleness monitor / startup recovery). Same for `StalenessMonitor`.
The `graceful-shutdown` example currently ships a user-side
`OutboxDrainService` workaround (convention #24) that the framework
should make unnecessary.

**DoD**: `stop()` returns a promise that resolves after the in-flight
batch completes; `onApplicationShutdown` awaits it (with a bounded
drain timeout); the `graceful-shutdown` example drops its workaround;
pinned by an integration test.

### C2. No automatic retry policy or terminal state — *needs DD/ADR*

"Retry" today is the operator-driven
`FailedEventPublications.resubmit()`. `completionAttempts` is
incremented on every claim but nothing consumes it automatically —
a permanently failing publication oscillates via manual resubmission
forever, with no backoff and no dead-letter-style terminal state.

Decision to take in the DD: opt-in automatic resubmission with
exponential backoff + jitter, a `maxAttempts` cut-off flipping the
publication into a terminal state (new status vs. flag), and how that
interacts with the Spring-Modulith-parity goal (Spring Modulith is
similarly operator-driven — intentionally diverging deserves a
recorded decision).

**DoD**: DD recorded; implementation (if accepted) covered by unit
specs including backoff timing and terminal-state transitions;
operator APIs extended to query the terminal state.

### C3. No observability: metrics, health, tracing — *needs DD/ADR*

No counters, gauges, histograms, health indicators, or spans anywhere
in the outbox stack. Core already has an observer pattern
(`packages/core/src/observability/`) — the natural shape is an
injectable outbox observer SPI (publication stored / claimed /
completed / failed / stale, queue depth, processing latency) that
metrics libraries or OpenTelemetry can bind to, plus an optional
`@nestjs/terminus` health indicator (outbox lag, stuck rows).
Full OpenTelemetry integration remains a
[future phase](README.md#future-phases-not-scheduled).

**DoD**: DD recorded for the observer SPI surface; hooks emitted from
processor / registry / staleness monitor; a documented example wiring
them to metrics; health indicator shipped or explicitly deferred.

### C4. No scheduled archive/cleanup job

`archiveCompleted(id)` and `deleteCompleted(olderThan?)` primitives
exist in the TypeORM repository, but nothing schedules them —
retention of completed publications is entirely manual.

**DoD**: opt-in periodic cleanup (interval + retention options on
`OutboxProcessingModule`, reusing the processor's self-rescheduling
timer pattern), disabled by default; covered by specs; documented in
the outbox README.

### C5. Silent-success gap — broker-aware externalizers (ADR-016)

`ClientProxy.emit()` is fire-and-forget on every transport: an
unreachable broker still yields a completed Observable, so the
processor marks the publication `COMPLETED` and the entire
retry/staleness/recovery machinery (which only fires on `FAILED`)
is bypassed. Documented in
[ADR-016](../adr/016-externalization-reliability-semantics.md) with
mitigations; the real fix is native broker-aware externalizers
(`kafkajs` / `amqplib` / `nats`) under the DD-018 `EVENT_EXTERNALIZER`
SPI, offering broker-acknowledged delivery. This is a full phase of
its own (new packages, real-broker testcontainers suites — the
`examples/externalization-with-fallback` docker-compose RabbitMQ is
the anchor) and should be scheduled after C1–C4.

**DoD**: phase plan drafted (package split, transport priority);
first externalizer shipped with real-broker integration tests;
ADR-016 amended by a superseding ADR once the gap closes.

## Workstream D — Deferred backlog

Recorded, not scheduled. Ordered roughly by value.

- **Examples in CI** — 19 workspace example apps are excluded from
  every CI job (`--filter './packages/*'`); they can silently break
  against library changes. A build (and optionally test) job over
  `examples/*` closes the biggest CI gap.
- **`.nvmrc` inconsistency** — pins `20` while `engines` demands
  `>=22.11.0` and CI tests 22/24/26. Trivial fix, real contributor
  friction.
- **Dependency & security automation** — no Dependabot/Renovate, no
  CodeQL/OSV scanning, no `format:check` job in CI.
- **Community health files** — `SECURITY.md` (expected at 1.0 given
  npm provenance is already wired), `CODE_OF_CONDUCT.md`, issue/PR
  templates, `CODEOWNERS`.
- **Local hooks** — no husky/lint-staged/commitlint despite
  CONTRIBUTING's commit conventions; enforcement is CI-only.
- **ESM dual packaging** — all packages are CJS-only (single
  `exports` condition set); already a
  [future phase](README.md#future-phases-not-scheduled). Add
  `sideEffects: false` to package manifests independently of the
  ESM work.
- **API reference & surface guard** — no TypeDoc/api-extractor;
  given [ADR-004](../adr/004-public-api-stability.md) commits to API
  stability, an `.api.md`-style surface snapshot would turn breaking
  changes into reviewable diffs.
- **Broken relative doc links** — 20 across 10 files, mostly example
  READMEs citing ADR/DD files by a guessed slug (`dd/019-single-unit-atomicity.md`
  for `019-hybrid-delivery-atomicity.md`, and so on). Surfaced while
  verifying links during C1. Worth a link-check step in CI so it
  cannot regress.
- **Docs site / benchmarks** — markdown-only docs, no published
  site; no perf harness behind the AsyncLocalStorage overhead
  claims.
- **`outbox-prisma` / `outbox-mongodb`** — roadmap-only, no
  scaffolding; unblocked by the Phase 14 multi-adapter contract.

## Suggested sequencing

1. ~~**Quick fixes**: A4, A8, plus documenting A1's current no-op
   behaviour in `known-limitations.md` as a stopgap.~~ **Shipped**,
   including the SPI-contract correction (DD-025) that A8's tail
   turned out to require.
2. ~~**Governance**: B1 + B2, then B3.~~ **Shipped** — all three
   together, since the gate and the missing tests it exposes could not
   be separated. Follow-on: raise the branch floors, weakest first
   (`typeorm` 62, `outbox-microservices` 65).
3. **API consistency**: A2, A3, A5, A7, then A6.
4. **A1 decision + implementation** (DD first).
5. **Outbox production readiness**: ~~C1~~ **shipped** → C2 (DD) →
   C3 (DD) → C4.
6. **C5 broker-aware externalizers** as its own scheduled phase.

Every user-facing change ships with a changeset; architectural items
(A1, C2, C3, C5) start as a DD/ADR discussion, not code.
