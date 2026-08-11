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

### A1. `readOnly` and `timeout` are declared but silently ignored — *shipped*

Decided and implemented per
[DD-027](../dd/027-readonly-and-timeout-semantics.md), which corrected a
premise in the recommendation below.

**`readOnly` is now enforced where the dialect allows it.** The TypeORM
adapter issues `SET TRANSACTION READ ONLY` as the transaction's first
statement on `postgres`, `cockroachdb` and `aurora-postgres`; a stray
write is refused by the database. Pinned by unit specs per dialect and
by integration tests against real Postgres, including that read-only
does not leak into the next transaction on the same pooled connection
and that a nested savepoint inherits it.

The recommendation below assumed MySQL was simply unimplemented. It is
not implementable: MySQL's `SET TRANSACTION` applies to the *next*
transaction and raises `ERROR 1568` inside a started one, so the access
mode has to be given as `START TRANSACTION READ ONLY` — a moment TypeORM
never exposes. Other dialects get a deliberate silent no-op rather than
an error, because `CqrsTransactionalModule` defaults every query handler
to `readOnly: true` and erroring would break consumers on an option they
never set.

Also worth recording: `readOnly` is a hint in Spring too, where the real
benefit comes from Hibernate's `FlushMode.MANUAL`. TypeORM has no unit of
work and no dirty checking, so there is no equivalent optimisation to
gain — which means "declared but not enforced" had been at parity all
along, and only the JSDoc oversold it.

**`timeout` stays declared and unimplemented, deliberately.** TypeORM
exposes no transaction-level timeout, and the nearest dialect feature —
Postgres' `statement_timeout` — bounds each statement rather than the
transaction, so `timeout: 5000` on a method issuing four queries would
allow twenty seconds. Attaching that meaning to this name would mislead
more than the documented gap does. It stays in the surface because
Prisma's `$transaction` accepts a real transaction budget, so a future
Prisma adapter can implement it correctly instead of us removing and
reintroducing the option.

An explicit dialect allowlist was unavoidable here — unlike the
savepoint check (A7), TypeORM publishes no capability flag for
transaction access mode. The adapter carries a comment saying the list
needs review when a driver is added.

Original finding and its stopgap:

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

### A2. `CqrsTransactionalModule` lacks `forRootAsync` — *shipped*

`forRootAsync` mirrors the shape core and typeorm already use:
structural flags on the options object, value-shaped config from the
factory. `useTransactionalEventPublisher` is the one structural flag
here — it decides whether the `EventPublisher` override provider is
registered at all, and NestJS needs provider tokens at
module-definition time, so it stays on the options object rather than
the factory result (the same split `OutboxModule.forRootAsync` uses for
`repository`, convention #21).

Both paths now share one `resolveWrapperOptions` defaults resolver and
one `buildModule` provider matrix, so they cannot drift; a spec asserts
the two produce identical `exports` and provider counts. The
`exports: exportTokens as never[]` cast is gone, replaced by a typed
`InjectionToken[]`.

Two things surfaced while doing it:

- Naming the local array `exports` broke the module at runtime — in the
  CommonJS output that shadows the module-level `exports` object, and
  the local `const`'s TDZ made every earlier `exports.X = ...`
  assignment in the file throw. Caught by the new specs, renamed to
  `exportTokens`, and the reason is now a comment so nobody
  reintroduces it.
- `module.get(EventPublisher)` from a root non-strict scope returns
  `CqrsModule`'s own publisher, not the override — in both `forRoot` and
  `forRootAsync`. The override reaches consumers through this module's
  `exports`, which is the same mechanism that makes a duplicate
  `CqrsModule` import shadow it (convention #6). Structural assertions
  on the returned `DynamicModule` are the reliable way to test it;
  behavioural coverage stays in the E2E spec.

Original finding:

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

### A3. `@nestjs/cqrs` peer range narrower than the rest of the repo — *shipped (kept, documented)*

Investigated and deliberately **not** widened. The wrapper's own
mechanism would work on `@nestjs/cqrs@10` — the handler-metadata
constants it reads (`__commandHandler__`, `__queryHandler__`,
`__eventsHandler__`) are identical across both majors, and
`CqrsModule.forRoot()` exists in both. But `AsyncContext` is a v11
addition, and it is the mechanism behind the request-scoped handler
support ADR-020 ships and the README advertises. Widening to `^10`
would promise a documented feature that cannot work there.

`@nestjs/cqrs@10` also peers on `@nestjs/common ^9 || ^10`, so a
consumer pinned to it is on NestJS 10 regardless — the narrower range
costs those users nothing they could otherwise have had.

The rationale is now in `packages/cqrs/README.md` under *Limitations*,
where someone comparing peer ranges will actually look.

Original finding:

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

### A5. `ResubmissionOptions.maxInFlight` is a dead option — *shipped*

Removed rather than implemented (DD-026): `resubmit` only issues cheap
status updates, the option has no counterpart in Spring Modulith, and
the quantities that actually bound load are `batchSize` here and
`maxConcurrent` on the processor. Breaking change to a published alpha
API, shipped with a changeset.

Original finding:

`ResubmissionOptions` (`packages/outbox/src/types/resubmission-options.ts`)
exposes `withMaxInFlight()` and a `maxInFlight` getter, but
`FailedEventPublications.resubmit()`
(`packages/outbox/src/api/failed-event-publications.ts`) never reads
it — only `batchSize`, `minAge`, `maxCompletionAttempts`, and
`filter` are honoured.

**DoD**: `maxInFlight` either implemented in `resubmit()` or removed
from the options type (breaking change → changeset), with tests
either way.

### A6. TypeORM patching layer has no contract tests — *shipped*

`packages/typeorm/test/unit/typeorm-internals.contract.spec.ts` asserts
the stock-TypeORM shapes the patches depend on. It imports only
`typeorm` — never our own modules, which install the patches as an
import side effect (convention #12) — so every assertion describes the
substrate rather than our code, and each failure message names the file
that has to be revisited.

The failure mode this guards against is the dangerous kind: if one of
these shapes changes, the patch stops taking effect and every repository
call quietly runs on its own autocommit connection instead of the
transaction. Nothing throws, and behavioural tests that only check
business outcomes would still pass against a single connection.

Shapes now pinned:

- `Repository`'s constructor assigns `manager` by **plain assignment**,
  so it routes through a prototype setter and creates no own property.
  This is the load-bearing one — a native class field or an
  `Object.defineProperty(this, ...)` would create an own property that
  shadows the patched getter.
- `Repository.prototype.manager` is not already an accessor in stock
  TypeORM.
- Repository data methods delegate through `this.manager` with
  `this.metadata.target`, which is what makes swapping `manager` enough
  to redirect them.
- `getRepository` lives on `EntityManager.prototype` (an own-instance
  method would escape the wrap), and `extend` lives on
  `Repository.prototype` and builds its child through the same
  constructor path.
- `DataSource` keeps `manager` as an own instance property, which is why
  `data-source-patches.ts` patches the instance rather than the
  prototype.
- `driver.transactionSupport` still exists — read by A7's savepoint
  check, which falls back to permissive if the flag disappears, so this
  test is the only thing that would notice.

Verified against both CI matrix cells: every assumption holds
identically in TypeORM 0.3 and 1.0 (checked by inspecting the published
1.0.0 tarball, since the suite only installs one version at a time
locally). The assertions were also probed against a simulated break —
emulating TypeORM switching to `defineProperty` for `manager` does
produce the own-property descriptor the contract test forbids.

Original finding:


`packages/typeorm/src/patching/*` concentrates ~54 `any` usages and
reaches into un-exported TypeORM internals
(`DataSource` / `Repository` / `EntityManager` prototypes). A
`typeorm` version bump can break it silently. The CI matrix already
exercises typeorm `0.3` and `1.0`, but there is no focused contract
suite asserting the internal shapes the patches rely on.

**DoD**: a contract spec per patched surface that fails loudly (with
a pointed message) when a TypeORM internal the patch depends on
changes shape; runs in the existing version matrix.

### A7. `runInSavepoint` never signals unsupported savepoints — *shipped*

`TypeOrmTransactionAdapter.runInSavepoint` now checks the driver's
capability before emitting SQL and throws
`IllegalTransactionStateError` — the error the `TransactionAdapter`
contract prescribes — naming the driver, the reported capability, and
the propagation modes to use instead.

No dialect allowlist was needed: TypeORM reports the capability itself
through `driver.transactionSupport`, which is `'nested'` for the
savepoint-capable drivers and `'simple'` (SQL Server, SAP HANA) or
`'none'` (MongoDB, Spanner, Cordova) otherwise. Same values in 0.3 and
1.0.

Deliberately permissive when the flag is absent: a TypeORM version that
renames or drops it must not turn every `NESTED` call into a hard
failure, since absence of the signal is not evidence of absent support.
A6's contract test covers that blind spot by failing if the flag
disappears.

Original finding:


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

### C2. No automatic retry policy or terminal state — *shipped*

**The framing in the original finding below was wrong and is corrected
by [DD-026](../dd/026-automatic-retry-policy.md).** Checking the Spring
Modulith reference showed it has no automatic retry with backoff and no
dead-letter state either — its model is exactly the one we had, with
"stop after N attempts" expressed as a filter over
`completionAttempts`, and the same five lifecycle states. So this was
never a parity gap; it was a question of whether to go past parity.

Shipped as an opt-in `OutboxRetryScheduler`: a per-dataSource
self-rescheduling worker, started and drained by
`OutboxProcessingModule` alongside the processor and staleness monitor,
configured through the new `retry` option. `maxAttempts: 0` (the
default) means no automatic retry and no timer, so nothing changes for
existing deployments.

Two decisions worth carrying forward:

- **No sixth lifecycle state.** A publication that exhausts its
  attempts stays `FAILED` and stays queryable; the cap bounds the
  automatic path only. Deferred rather than refused — `status` is a
  plain `varchar(32)`, so an `ABANDONED` state could be added later
  without a migration if alerting on the compound predicate proves
  painful.
- **Layered on the operator API.** The scheduler calls
  `FailedEventPublications.resubmit()` with a backoff predicate as its
  filter, so there is one resubmission code path and the parity story
  stays intact.

Backoff needed no schema change: eligibility is measured from
`lastResubmissionDate ?? publicationDate`, which is exact from the
second retry onward. The known imprecision — a long-lived publication
that just failed is immediately due for its first retry — is documented
in DD-026 and bounded by the scheduler's own interval.

Pinned by 18 scheduler specs plus three module-level wiring specs (the
default-disabled config, option pass-through, and an end-to-end
fail → auto-resubmit → complete cycle proving the scheduler is bound to
the right per-dataSource repository). Mutation-checked: flattening the
backoff curve to zero and an off-by-one in the attempt cap each fail
three specs.

Not done here: nothing consumes the retry outcome for alerting, which
is C3's territory.

Original finding (framing since corrected):

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

- ~~**Examples in CI**~~ — *fixed.* All 19 workspace example apps were
  excluded from every CI job (`--filter './packages/*'`) and could
  silently break against library changes. The `examples` job now builds
  the packages, then builds all 19 examples, runs their unit tests and
  runs the 14 `test:integration` suites against testcontainers Postgres
  — 19 builds, 26 unit tests, 65 integration tests, ~25s on top of the
  install and package build.

  Deliberately off the TypeORM matrix, and the job says why: the
  examples declare `typeorm ^1.1.0`, and the override the matrix legs
  use is repo-wide, so forcing an older TypeORM onto them puts two
  copies in one workspace — which resolves `getDataSourceToken()`
  against the wrong `DataSource` class. Peer-range coverage is the
  matrix's job; this one asks whether a consumer app still works.

  The gap was not hypothetical: the TypeORM 1.1.0 bump broke
  `examples/basic-transactional` at runtime through exactly that
  mechanism, and nothing in CI would have noticed.
- ~~**`.nvmrc` inconsistency**~~ — *fixed.* Pinned `20` against an
  `engines` floor of `>=22.11.0`. Now `22`, matching CI's
  `node-version: 22`, and the root `engines` floor moved to `>=22.13.0`
  — the real development floor, since TypeORM 1.x requires `^22.13.0`
  on the 22 line. The two adapter packages already declared that;
  the root and CONTRIBUTING still said 22.11.
- ~~**Dependency & security automation**~~ — *fixed.* Dependabot
  (weekly, npm + github-actions, grouped so a NestJS or ESLint bump is
  one PR rather than a dozen that each fail until the others land) and
  a CodeQL workflow with the `security-and-quality` query pack. Both
  are GitHub-native, so neither added an npm dependency. `typeorm` is
  on Dependabot's ignore list on purpose: which version the lockfile
  pins is tied to the CI matrix and to what the examples declare, and a
  bot bumping it would quietly change what the matrix means.

  `format:check` now runs as the `format` job. Enabling it required a
  one-off reformat of 72 source files — the script had existed since
  the first release and had never been enforced, so the tree had
  drifted. Prettier's scope was narrowed at the same time: root
  markdown joined `docs/` and `CLAUDE.md` in `.prettierignore`, because
  Prettier does not tidy hand-wrapped prose so much as rewrite it — on
  `AGENTS.md` it turned a continuation line starting with `+` into a
  `-` list item, changing what the sentence said. Formatting is
  enforced on code; prose stays hand-wrapped.
- ~~**Community health files**~~ — *fixed.* `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, `.github/CODEOWNERS`, two issue forms with a
  `config.yml`, and a PR template.

  The bug-report form asks for the dialect and whether the deployment
  is multi-dataSource, because both change the answer — `readOnly` is
  enforced only on the Postgres family (DD-027) and multi-DS has its
  own documented limitations — and it points at
  `known-limitations.md` and ADR-016 up front, since a fair share of
  "bugs" here are documented trade-offs. `SECURITY.md` also records
  the data-at-rest footprint (serialized payloads and listener
  exception messages persist in `event_publication` until purged),
  which is not a vulnerability but is worth not discovering by
  surprise.

  Vulnerability reports route through GitHub's private reporting,
  which **must be enabled in repository settings** for the link to
  work. CODEOWNERS likewise only gates merges once branch protection
  requires code-owner review.
- ~~**Local hooks**~~ — *fixed.* husky, lint-staged and commitlint.
  pre-commit formats staged files through exactly the set the `format`
  job checks, so hook and gate cannot disagree; commit-msg runs
  commitlint. ESLint is deliberately absent from pre-commit — its
  type-aware rules resolve cross-package imports through `dist/*.d.ts`,
  so it would mean building six packages per commit.

  Three commitlint defaults are relaxed, each because the default
  rejected commits this history actually contains: `header-max-length`
  raised to 120 (three headers run 103–108), `subject-case` disabled
  (subjects legitimately open with identifiers — `ADR-019 — ...`,
  `OutboxTypeOrmModule reshape ...`), and the body/footer line-length
  caps disabled (bodies carry URLs). No `scope-enum`: the history uses
  19 distinct scopes, including combined ones like `cqrs,outbox`.
- **ESM dual packaging** — all packages are CJS-only (single
  `exports` condition set); already a
  [future phase](README.md#future-phases-not-scheduled).

  `sideEffects` is now declared, and not uniformly, because the
  uniform answer would have been false. `core`, `cqrs`, `outbox` and
  `outbox-microservices` have no import-time statements and say
  `false`. The other two do, so they list the files instead:
  `typeorm` calls `applyAllPatches()` at module load, and a bundler
  told the package is side-effect-free may drop that module when a
  consumer imports only, say, `getCurrentEntityManager` — the
  prototype patches would then never install and transparent
  repositories would silently stop being transactional.
  `outbox-typeorm`'s `@Entity()` decorators register into TypeORM's
  global metadata storage at import time, so its entity files are
  listed too.
- ~~**API surface guard**~~ — *fixed.* `@microsoft/api-extractor`
  reports the signature of every entry point into
  `packages/<name>/etc/*.api.md`, committed, and the `api-surface` CI
  job fails when the built surface differs. Eight reports rather than
  six: api-extractor covers one entry point per run, and `core` and
  `outbox` each publish a `./testing` subpath. 1658 lines total.

  This is what makes [ADR-004](../adr/004-public-api-stability.md)
  checkable — the stability promise had been resting on someone
  noticing a changed export in review. Baselined deliberately *before*
  `1.0.0`: later, the first diff would have nothing meaningful to
  compare against and the surface `1.0.0` froze would never have been
  recorded.

  Two configuration notes worth keeping. `ae-unresolved-link` is off:
  it fires on `{@link id}`-style shorthand for a sibling member, which
  api-extractor cannot resolve but which is idiomatic TSDoc and works
  in IDE tooltips — checked against a sample before silencing, and it
  was dozens of warnings per package. `ae-missing-release-tag` is off
  because ADR-004 draws the public/internal line by entry point rather
  than with `@public` / `@internal` tags. `ae-forgotten-export` stays
  on and currently reports nothing, which is the interesting part: no
  public signature references a type a consumer cannot name.

  Verified by mutation: adding one exported interface makes
  `pnpm api:check` exit 1. Worth having checked — api-extractor calls
  a changed surface a *warning* in its output, so the run reads as
  benign; only the exit code is unambiguous.

  Still not covered: TypeDoc-style rendered API reference. That is a
  docs-site concern, below.
- **`publint` + `@arethetypeswrong/cli`** — not added; the dependencies
  were not approved. ADR-004 has claimed since before the first release
  that both "run in CI" and are "non-negotiable parts of the release
  process"; neither was ever wired up. The ADR now states that
  plainly rather than continuing to assert it. Until they exist,
  nothing verifies that what a consumer resolves from the published
  tarball matches what the sources declare — the `type-check` job
  compiles the sources, which is a different question.
- ~~**Broken relative doc links**~~ — *fixed.* 20 across 10 files,
  mostly example READMEs citing ADR/DD files by a guessed slug
  (`dd/019-single-unit-atomicity.md` for
  `019-hybrid-delivery-atomicity.md`, and so on). Surfaced while
  verifying links during C1. All repointed at real files, and
  `scripts/check-doc-links.sh` now gates it in CI (`doc-links` job) so
  it cannot regress.

  Two needed judgement rather than a slug swap: the text
  "dataSource name as primary identifier" describes DD-020, not the
  DD-021 the number claimed, and `docs/architecture/cqrs-integration.md`
  never existed at all — the two examples citing it now point at
  `packages/cqrs/README.md`, which actually documents the integration.
- **Docs site / benchmarks** — markdown-only docs, no published
  site; no perf harness behind the AsyncLocalStorage overhead
  claims.
- **`outbox-prisma` / `outbox-mongodb`** — roadmap-only, no
  scaffolding; unblocked by the multi-adapter contract.

## Suggested sequencing

1. ~~**Quick fixes**: A4, A8, plus documenting A1's current no-op
   behaviour in `known-limitations.md` as a stopgap.~~ **Shipped**,
   including the SPI-contract correction (DD-025) that A8's tail
   turned out to require.
2. ~~**Governance**: B1 + B2, then B3.~~ **Shipped** — all three
   together, since the gate and the missing tests it exposes could not
   be separated. Follow-on: raise the branch floors, weakest first
   (`typeorm` 62, `outbox-microservices` 65).
3. ~~**API consistency**: A2, A3, A5, A7, A6.~~ **Shipped** — workstream A is
   complete except A1, whose DD is still open.
4. ~~**A1 decision + implementation** (DD first).~~ **Shipped** (DD-027) —
   workstream A is now complete.
5. **Outbox production readiness**: ~~C1~~ ~~C2~~ **shipped** → C3 (DD)
   → C4.
6. **C5 broker-aware externalizers** as its own scheduled phase.

Every user-facing change ships with a changeset; architectural items
(A1, C2, C3, C5) start as a DD/ADR discussion, not code.
