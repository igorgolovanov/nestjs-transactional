# @nestjs-transactional/outbox

## 1.0.0

### Minor Changes

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`6c3b21f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6c3b21fa7e9ed4ec149fd22c6cff21e598b2b73f) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Optional automatic retry for `FAILED` publications, and removal of the
  dead `ResubmissionOptions.maxInFlight` option.

  Recovery used to be entirely operator-driven: someone had to call
  `FailedEventPublications.resubmit(...)`, there was no backoff, and
  nothing consumed `completionAttempts`, so a permanently failing
  publication could be resubmitted forever. Checking the Spring Modulith
  reference while designing this turned up something worth stating plainly:
  **Spring Modulith has no automatic retry or dead-letter state either.**
  Its model is the one we already had. So this is not a parity fix — it is
  a deliberate step past parity, and it is opt-in.

  `OutboxRetryScheduler` resubmits failed publications whose backoff window
  has elapsed, on its own interval, and stops selecting a publication once
  it has used up its attempts. Configure it through the new `retry` option
  on `OutboxModule.forRoot` / `forRootAsync`:

  ```ts
  OutboxModule.forRoot({
    retry: {
      maxAttempts: 3, // counts the first delivery: original + 2 retries
      interval: 60_000,
      baseDelay: 1_000,
      factor: 2, // baseDelay * factor^(attempts - 1)
      maxDelay: 300_000,
      jitter: 0.2, // spread retries after a mass failure
      batchSize: 100,
    },
  });
  ```

  **Off unless you ask for it.** `maxAttempts` defaults to `0`, which means
  no automatic retry and no timer is ever scheduled — the same "0 disables"
  convention `StalenessConfig` uses. Existing deployments behave exactly as
  before.

  **No new lifecycle state.** A publication that exhausts its attempts
  stays `FAILED`, still listed by `FailedEventPublications.findAll(...)`,
  and an operator can still resubmit it by hand; the cap bounds the
  automatic path only. The cost of that choice is that "will never be
  retried again" is a compound query rather than a status lookup — see
  DD-026 for why a sixth state was deferred rather than added.

  **Built on the operator API, not beside it.** The scheduler calls
  `resubmit()` with a backoff predicate as its filter, so there is one
  resubmission code path, and anything the scheduler does you can do
  yourself from your own cron if you want different selection logic.

  Backoff needs no schema change: eligibility is measured from
  `lastResubmissionDate ?? publicationDate`. The one imprecision is that a
  publication which lived a long time before failing is immediately due for
  its _first_ retry, since there is no failure timestamp to measure from.
  Every later window is exact.

  **Breaking:** `ResubmissionOptions.maxInFlight` and `withMaxInFlight()`
  are removed. The option was declared but never read, and has no
  counterpart in Spring Modulith. `resubmit` only issues cheap status
  updates; the quantities that actually bound load are `batchSize` here and
  `maxConcurrent` on the processor.

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`f4f7aea`](https://github.com/igorgolovanov/nestjs-transactional/commit/f4f7aea7d8d5cf11bcbc443d4b0b422cb0bdf19d) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Shutdown now drains in-flight outbox work instead of abandoning it.

  `OutboxProcessingModule.onApplicationShutdown` used to be synchronous:
  it set `running = false` and cancelled the next-poll `setTimeout`, but
  did not await the `processBatch()` already dispatched by the previous
  tick. NestJS moved straight on to destroying providers — the TypeORM
  `DataSource` among them — so an in-flight `processOne()` writing
  `PROCESSING → COMPLETED` could race the connection-pool teardown and
  leave the row stuck in `PROCESSING` until the staleness monitor
  recovered it on a later boot.

  `EventPublicationProcessor.stop()` and `StalenessMonitor.stop()` are now
  `async` and await the work already in flight; the module hook awaits all
  of them concurrently, so multi-dataSource deployments do not add up
  their budgets. An idle worker still resolves immediately — the drain
  costs nothing when there is nothing to drain.

  Two new options bound the wait: `processor.shutdownTimeout` and
  `staleness.shutdownTimeout`, both defaulting to the exported
  `DEFAULT_DRAIN_TIMEOUT_MS` (10 s, sized so a 30-second platform grace
  period still has room for the pool to close and logs to flush). Set
  either to `0` to restore the previous no-wait behaviour.

  Work abandoned at the deadline is abandoned, not cancelled — there is no
  safe way to interrupt a half-finished listener invocation. The trade-off
  is deliberate: shutdown latency against recovery lag, never durability.
  A publication left in `PROCESSING` is still recovered by the staleness
  monitor, whereas blocking a deployment indefinitely on a stuck listener
  would be the worse failure.

  **Migration.** If you wrote a user-side drain service against the old
  behaviour (convention [#24](https://github.com/igorgolovanov/nestjs-transactional/issues/24) documented one, and the `graceful-shutdown`
  example shipped it), delete it and set `shutdownTimeout` instead. Two
  drains racing each other is harder to reason about than one.

  `stop()` returning `Promise<void>` rather than `void` is technically a
  signature change; callers that ignore the result are unaffected at
  runtime.

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`1b010e4`](https://github.com/igorgolovanov/nestjs-transactional/commit/1b010e4424462aba825ae782b44b4771f4e4491b) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Rewrites every package README, and exports three types that public
  signatures already referenced.

  **Three types are now importable.** Each appeared in a public signature
  without being exported, so a consumer could call the method but not name
  its types — found by `api-extractor`'s `ae-forgotten-export` once the
  API surface reports landed:
  - `CqrsTransactionalAsyncOptions` and `CqrsTransactionalAsyncFactoryResult`
    — the options type of `CqrsTransactionalModule.forRootAsync`.
  - `AggregateConstructor` — the constraint on `mergeClassContext`'s type
    parameter.
  - `RegistrarListenerEntry` — the parameter type of
    `MultiDsOutboxListenerRegistrar.register`.

  **The READMEs are rewritten, and several of them were wrong.** These are
  the pages npm renders, and they had drifted:
  - `core` showed `timeout: 10_000` in an options example. `timeout` is
    accepted by the type and not implemented; the README now says so and
    explains why it is deliberately not approximated.
  - `outbox`'s primary wiring snippet passed `adapters: [...]` to
    `TransactionalModule.forRoot`. There is no such option — the field is
    `adapter`, singular — so the first snippet a reader copies did not
    compile.
  - `typeorm` told readers to import
    `@nestjs-transactional/typeorm/test/setup-testcontainers`. Nothing
    under `test/` is published, so that import cannot resolve.
  - `outbox-typeorm` documented `OutboxTypeOrmModule.forFeature` and an
    `isDefault` option, neither of which exists, described the module
    wiring as arriving "in a later iteration" two paragraphs before
    documenting it, and headed its install section "Installation (once
    published)".
  - All six claimed the API "may change between 0.x releases" while
    shipping as `1.0.0-alpha.x`.
  - All six linked to documentation with relative paths like
    `../../docs/adr/...` — seventy links in total, every one of them dead
    on npmjs.com, which renders a README outside the repository tree. They
    are now absolute, and `scripts/check-doc-links.sh` resolves in-repo
    GitHub URLs so they stay checked.

  Beyond the corrections, each README now leads with what the package is
  for and a snippet that runs, keeps the caveats that actually bite —
  `readOnly` being per-dialect, the outbox's in-memory default silently
  discarding everything, `ClientProxy.emit()` not reporting broker
  failure, importing `CqrsModule` twice shadowing the publisher override —
  and links out for the rest instead of inlining it. They are about half
  their previous length.

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  Persistent Event Publication Registry — Spring Modulith
  `@ApplicationModuleListener` durability semantics for NestJS.
  - `EventPublication` lifecycle states (`PUBLISHED`, `PROCESSING`,
    `COMPLETED`, `FAILED`, `RESUBMITTED`).
  - `EventPublicationRepository` SPI; `InMemoryEventPublicationRepository`
    shipped for tests.
  - `EventTypeRegistry` for cross-restart deserialization.
  - `OutboxListenerRegistry` and class-level `@OutboxEventsHandler`
    decorator (ADR-014). Stable listener id format
    `${baseId}#${EventName}` for rename safety (ADR-009).
  - `OutboxEventPublisher` — smart facade detecting active dataSource
    via `TransactionContext` (DD-024). Multi-DS routing via per-event
    registry plus explicit override.
  - `EventPublicationProcessor` async worker; `StalenessMonitor`
    detects publications stuck in `PROCESSING`;
    `StartupRecoveryService` republishes on restart.
  - Operator APIs: `FailedEventPublications` (with `resubmit(...)`),
    `IncompleteEventPublications`, `CompletedEventPublications`.
  - Completion modes: `UPDATE`, `DELETE`, `ARCHIVE`.
  - `@Externalized` SPI + `EventExternalizer` structural port (DD-018)
    for broker delivery — concrete implementations in
    `@nestjs-transactional/outbox-microservices`.
  - `OutboxModule.forRoot({ ... dataSource? })` /
    `OutboxModule.forFeature(events, { dataSource? })` — multi-`forRoot`
    pattern (ADR-019); per-DS event-type registries; static-class
    storage coordinates singletons across calls.
  - `OutboxProcessingModule` for worker processes.
  - `/testing` subpath: `PublishedEvents` and
    `AssertablePublishedEvents` mirror Spring Modulith's helpers.

  Peer deps: `@nestjs-transactional/core`. Persistence backends ship
  separately (`outbox-typeorm`); the in-memory repo is sufficient for
  unit tests. Public alpha.

### Patch Changes

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`31d9de4`](https://github.com/igorgolovanov/nestjs-transactional/commit/31d9de4ca35f69f8b384229f8c38bc13fe9a67dd) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Documentation accuracy pass — three claims corrected. No runtime
  behaviour changes; JSDoc, README and guide text only.

  **`readOnly` / `timeout` are documented as unimplemented.** Both
  options on `TransactionOptions` are accepted by the core and handed to
  the adapter, but the shipped `TypeOrmTransactionAdapter` forwards only
  `isolation` — so both are no-ops today. Their JSDoc previously read as
  a working feature ("Adapters may ... issue `SET TRANSACTION READ ONLY`",
  "exceeding this triggers a rollback"), which made `@ReadOnly()` and
  `CqrsTransactionalModule`'s `defaultQueryOptions: { readOnly: true }`
  default look like write protection. The options keep their place in the
  type surface — they are the intended extension point, and the
  `TransactionAdapter` contract permits adapters to honour them — but the
  JSDoc on `TransactionOptions.readOnly`, `TransactionOptions.timeout`,
  `@ReadOnly`, and the cqrs module now say plainly that nothing enforces
  them yet, and point at `docs/known-limitations.md`, which gained a
  dedicated entry.

  **`CqrsTransactionalModule`'s `@example` no longer violates
  convention [#6](https://github.com/igorgolovanov/nestjs-transactional/issues/6).** The shipped example imported `@nestjs/cqrs`'s
  `CqrsModule` alongside `CqrsTransactionalModule.forRoot()` — the exact
  double-import that shadows the `EventPublisher` override and silently
  routes aggregate events around the dispatcher. It was the only place in
  the repository still showing that pattern, and it shipped in the
  `.d.ts`. The example also referenced a non-existent
  `TypeOrmTransactionalModule.forFeature(...)`; it now uses `forRoot`.

  **The `EventPublicationRepository` concurrency contract is stated
  correctly, and on the right method.** Docs and the SPI's own JSDoc
  required production `findReadyForProcessing` implementations to use
  `SELECT ... FOR UPDATE SKIP LOCKED` "to be safe against concurrent
  workers". No shipped implementation does — row locking was dropped
  before release, because a pessimistic lock has to be held by a
  transaction spanning the listener invocation, which is unsafe for
  long-running listeners. The in-memory reference implementation does not
  lock either, and the interface contradicted itself: `tryClaim`'s JSDoc
  also claimed responsibility for preventing double-processing.

  `tryClaim` is the method that actually carries the guarantee, and its
  JSDoc now says so normatively: the status check and the transition MUST
  be one indivisible operation (conditional `UPDATE` with affected-row
  count, `findOneAndUpdate` with the status in the filter, or equivalent
  compare-and-set), because a read-then-write claim lets two workers both
  observe `PUBLISHED` and both dispatch. `findReadyForProcessing` is
  documented as deliberately non-exclusive — overlapping results are
  allowed, and a losing claim costs a wasted read rather than a duplicate
  dispatch. Row locking remains permitted as an optimisation but may not
  be relied on for correctness.

  This matters to anyone implementing the SPI for another datastore
  (`outbox-prisma`, `outbox-mongodb`): the previous wording pointed the
  obligation at the wrong method. Rationale and alternatives:
  [DD-025](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/025-claim-atomicity-obligation.md).
  ADR-007's SPI-contract appendix is corrected in place with an amendment
  note; its decision (the `outbox` / `outbox-typeorm` package split) is
  unchanged. No behaviour changed in either shipped backend — both
  already matched the corrected contract.

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`f9ff0b6`](https://github.com/igorgolovanov/nestjs-transactional/commit/f9ff0b67f38220958c6a486d09e6766c60ea18c5) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Removed internal phase numbers from the published API documentation.

  The JSDoc carried 90 references to this project's internal roadmap
  phases, and 52 of them reached the shipped `.d.ts` files — so hovering
  `TransactionalModule.forRoot` in an editor produced "mirrors Phase 14.3.2
  `OutboxModule` per ADR-019", and `@Externalized`'s docs mentioned "Phase
  11.3". None of that means anything to someone consuming the library.

  Where the number stood in for a feature, it is replaced by the feature's
  name ("transparent transactional repositories", "per-dataSource handler
  routing", "event externalization"); where it was pure bookkeeping, the
  parenthetical is gone. No behaviour, signature, or type changed —
  `.d.ts` output differs only in comments.

  Two stale statements surfaced while doing this and were corrected rather
  than relabelled: `OutboxListenerRegistry` claimed the scanner that
  populates it was an "upcoming" iteration (it shipped long ago), and a
  multi-dataSource spec claimed per-dataSource listener routing was still
  pending. Also user-visible: the runtime warning about
  `headers`/`routingKey` not reaching the wire payload no longer cites a
  phase number.

  Phase numbering is retained where it does real work: `docs/roadmap/`
  (which is the phase history), and the ADR/DD status headers and revision
  histories, where phase anchors stand in for dates by convention.

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`4c84e2d`](https://github.com/igorgolovanov/nestjs-transactional/commit/4c84e2df45aafdc1448fe27214ca2082abe0b86b) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - `1.0.0` — the packages leave the alpha series.

  `npm install @nestjs-transactional/core` now resolves to a stable
  release. Until now it returned nothing useful without an explicit
  `@alpha`, because the manifests pinned the `alpha` dist-tag; that pin is
  gone and publishing goes to `latest`.

  The alpha labels are gone from the READMEs too, along with the claim
  that the API "may change between 0.x releases" — which was doubly wrong,
  since the cohort never sat on `0.x`. From here the surface is under
  [ADR-004](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/004-public-api-stability.md):
  a breaking change costs a major bump _and_ an ADR explaining it.

  That promise is machine-checked rather than asserted. The committed
  api-extractor reports under `packages/*/etc/*.api.md` turn any change to
  the published surface into a reviewable diff, and `publint` plus
  `@arethetypeswrong/cli` verify on every CI run that what a consumer
  resolves from the tarball matches what the sources declare.

- [#8](https://github.com/igorgolovanov/nestjs-transactional/pull/8) [`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Pin npm dist-tag to `alpha` while in the pre-release cohort.

  Each package's `publishConfig` now declares `"tag": "alpha"`, so
  `npm publish` (driven by `changesets/action` from the Release
  workflow) places every pre-release into the `alpha` dist-tag instead
  of `latest`. Previously the `release` script (`changeset publish`)
  did not pass `--tag`, and changesets does not infer the pre-release
  tag automatically — so the second and every subsequent
  pre-release publish wrote the new version into `latest`, leaving
  the `alpha` tag pointing at `1.0.0-alpha.0` while `latest` advanced
  to the freshest pre-release. That was already the case on
  `@nestjs-transactional/typeorm` and `@nestjs-transactional/outbox-typeorm`
  after the TypeORM 1.0 bump (`1.0.0-alpha.0` → `1.0.0-alpha.1`) and on
  `@nestjs-transactional/cqrs` after ADR-020 (`1.0.0-alpha.0` →
  `1.0.0-alpha.2`); manual `npm dist-tag` runs corrected the registry.

  `publishConfig.tag` is declarative per-package and survives
  `changesets/action` updates without changes to the release workflow
  or root scripts. The setting will be removed (or flipped to `latest`)
  as part of the `pnpm changeset pre exit` step before promoting the
  cohort to stable `1.0.0`.

  No functional change to any package's runtime behaviour or public
  API — `package.json` metadata only.

- [#12](https://github.com/igorgolovanov/nestjs-transactional/pull/12) [`382ded3`](https://github.com/igorgolovanov/nestjs-transactional/commit/382ded3ae8c46ed74831ad6665fa1b5062624212) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Move the alpha dist-tag through a post-publish step in
  `release.yml`.

  The previous attempt added `--tag alpha` to the root `release`
  script. `@changesets/cli publish` rejects that in pre-release mode
  with "Releasing under custom tag is not allowed in pre mode"
  ([changesets/changesets#942](https://github.com/changesets/changesets/issues/942)),
  so the publish step failed before any package reached npm.

  The workflow now runs `changeset publish` without `--tag` (which
  defaults to `latest`), and a follow-up step iterates
  `steps.changesets.outputs.publishedPackages` and calls
  `npm dist-tag add <name>@<version> alpha` for each. The freshly
  published pre-releases land in both `latest` and `alpha`; subsequent
  `npm install @nestjs-transactional/<pkg>@alpha` resolves to the
  newest pre-release rather than to a stale `1.0.0-alpha.0`.

  Two guards prevent the step from tagging stable versions as
  `alpha` after `pnpm changeset pre exit`:
  1. `if: hashFiles('.changeset/pre.json') != ''` — primary gate.
     `pre.json` exists only while the cohort is in pre-release mode;
     the file is removed by `changeset pre exit`.
  2. Per-version skip on a missing prerelease segment (no `-` in the
     semver) — safety net for a mixed publish run or a misconfigured
     pre-exit.

  `publishConfig.tag = "alpha"` from a prior change stays in the
  package manifests as declarative metadata for direct `npm publish`
  callers. Both — the workflow step and the manifest field — become
  no-ops after `pnpm changeset pre exit` for stable `1.0.0`.

  No functional / API change — release infrastructure only.

- [#10](https://github.com/igorgolovanov/nestjs-transactional/pull/10) [`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Pass `--tag alpha` to `changeset publish` in the release script.

  Previous attempt declared `publishConfig.tag = "alpha"` in each
  package's `package.json`. The metadata reached the npm registry,
  but `@changesets/cli publish` overrides it with its own `--tag`
  argument (defaulting to `latest`), so every pre-release after
  `1.0.0-alpha.0` continued to land in the `latest` dist-tag while
  `alpha` stayed pinned to the initial version.

  The fix is a single CLI flag in the root `release` script:

  ```diff
  - "release": "changeset publish"
  + "release": "changeset publish --tag alpha"
  ```

  `changesets/action` invokes this script from the Release workflow,
  so the flag propagates to every package in the same publish run.
  The previously-added `publishConfig.tag` stays in place as
  declarative metadata for direct `npm publish` callers (where it
  still applies); it will be removed alongside the `--tag alpha`
  flag during `pnpm changeset pre exit` for stable `1.0.0`.

  No functional / API change — release infrastructure only.

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`88b9ca5`](https://github.com/igorgolovanov/nestjs-transactional/commit/88b9ca5a8fef43ba221982425c518d6cd2db350b) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Every package now declares `sideEffects`, so a bundler can tree-shake
  what is safe to drop and keep what is not.

  The declaration is **not** uniform, because the uniform answer would
  have been wrong:
  - `core`, `cqrs`, `outbox` and `outbox-microservices` have no
    import-time statements at all and declare `"sideEffects": false`.
  - `typeorm` calls `applyAllPatches()` at module load — that is how the
    `Repository.prototype` patches behind transparent transactional
    repositories get installed. It declares
    `["./dist/module/typeorm-transactional.module.js"]`. A blanket
    `false` here would let a bundler drop that module when a consumer
    imports only, say, `getCurrentEntityManager`, and the patches would
    never install: repositories would keep working and would silently
    stop being transactional.
  - `outbox-typeorm`'s `@Entity()` decorators register into TypeORM's
    global metadata storage when the entity modules are evaluated, so it
    declares `["./dist/entity/*.js"]`.

  No runtime behaviour changes. The packages are still CJS-only, so this
  mostly matters to consumers who bundle (a serverless function, say) and
  to the ESM dual-packaging work when it lands.

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`f134d8a`](https://github.com/igorgolovanov/nestjs-transactional/commit/f134d8afbef9c715f2ffcfef76ce4b8dd10f31ef) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Fixes the `/testing` subpath for consumers on the default CommonJS
  module resolution.

  `@nestjs-transactional/core/testing` and
  `@nestjs-transactional/outbox/testing` did not resolve to their type
  declarations under `node10` resolution — which is what TypeScript
  selects for `module: commonjs` when a project does not name
  `moduleResolution` explicitly, and therefore what a stock NestJS
  `tsconfig.json` gets. The import failed with:

  ```
  error TS2307: Cannot find module '@nestjs-transactional/core/testing'
    or its corresponding type declarations.
    There are types at '.../dist/testing/index.d.ts', but this result
    could not be resolved under your current 'moduleResolution' setting.
  ```

  `node10` predates `exports` maps and looks for `<pkg>/testing/` on
  disk, so it never saw `dist/testing/index.d.ts`. Both packages now
  declare `typesVersions` pointing at it, which is the supported way to
  serve subpath types to that resolution mode.

  **Runtime was never affected.** Node honours the `exports` map
  regardless of the TypeScript setting, so `require()` and the built
  JavaScript always worked; only type resolution failed. If you had
  worked around this by setting `moduleResolution: "node16"` or by
  importing from a deep path, neither is needed any more, and both keep
  working.

  Also on every package, from `publint`:
  - `"type": "commonjs"` is now declared, making the intent explicit
    rather than leaving Node to detect it.
  - `repository.url` carries the canonical `git+https://` prefix.

  Both `publint` and `@arethetypeswrong/cli` now run in CI
  (`pnpm publish:check`), which is how the subpath defect was found —
  [ADR-004](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/004-public-api-stability.md)
  had claimed for six alpha releases that they already did.

- Updated dependencies [[`31d9de4`](https://github.com/igorgolovanov/nestjs-transactional/commit/31d9de4ca35f69f8b384229f8c38bc13fe9a67dd), [`f9ff0b6`](https://github.com/igorgolovanov/nestjs-transactional/commit/f9ff0b67f38220958c6a486d09e6766c60ea18c5), [`4c84e2d`](https://github.com/igorgolovanov/nestjs-transactional/commit/4c84e2df45aafdc1448fe27214ca2082abe0b86b), [`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035), [`1b010e4`](https://github.com/igorgolovanov/nestjs-transactional/commit/1b010e4424462aba825ae782b44b4771f4e4491b), [`a33ba73`](https://github.com/igorgolovanov/nestjs-transactional/commit/a33ba733cf67662ed9fa4bb34d6a82b2144474f7), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`382ded3`](https://github.com/igorgolovanov/nestjs-transactional/commit/382ded3ae8c46ed74831ad6665fa1b5062624212), [`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9), [`88b9ca5`](https://github.com/igorgolovanov/nestjs-transactional/commit/88b9ca5a8fef43ba221982425c518d6cd2db350b), [`f134d8a`](https://github.com/igorgolovanov/nestjs-transactional/commit/f134d8afbef9c715f2ffcfef76ce4b8dd10f31ef)]:
  - @nestjs-transactional/core@1.0.0

## 1.0.0-alpha.5

### Patch Changes

- [#12](https://github.com/igorgolovanov/nestjs-transactional/pull/12) [`382ded3`](https://github.com/igorgolovanov/nestjs-transactional/commit/382ded3ae8c46ed74831ad6665fa1b5062624212) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Move the alpha dist-tag through a post-publish step in
  `release.yml`.

  The previous attempt added `--tag alpha` to the root `release`
  script. `@changesets/cli publish` rejects that in pre-release mode
  with "Releasing under custom tag is not allowed in pre mode"
  ([changesets/changesets#942](https://github.com/changesets/changesets/issues/942)),
  so the publish step failed before any package reached npm.

  The workflow now runs `changeset publish` without `--tag` (which
  defaults to `latest`), and a follow-up step iterates
  `steps.changesets.outputs.publishedPackages` and calls
  `npm dist-tag add <name>@<version> alpha` for each. The freshly
  published pre-releases land in both `latest` and `alpha`; subsequent
  `npm install @nestjs-transactional/<pkg>@alpha` resolves to the
  newest pre-release rather than to a stale `1.0.0-alpha.0`.

  Two guards prevent the step from tagging stable versions as
  `alpha` after `pnpm changeset pre exit`:
  1. `if: hashFiles('.changeset/pre.json') != ''` — primary gate.
     `pre.json` exists only while the cohort is in pre-release mode;
     the file is removed by `changeset pre exit`.
  2. Per-version skip on a missing prerelease segment (no `-` in the
     semver) — safety net for a mixed publish run or a misconfigured
     pre-exit.

  `publishConfig.tag = "alpha"` from a prior change stays in the
  package manifests as declarative metadata for direct `npm publish`
  callers. Both — the workflow step and the manifest field — become
  no-ops after `pnpm changeset pre exit` for stable `1.0.0`.

  No functional / API change — release infrastructure only.

- Updated dependencies [[`382ded3`](https://github.com/igorgolovanov/nestjs-transactional/commit/382ded3ae8c46ed74831ad6665fa1b5062624212)]:
  - @nestjs-transactional/core@1.0.0-alpha.5

## 1.0.0-alpha.4

### Patch Changes

- [#10](https://github.com/igorgolovanov/nestjs-transactional/pull/10) [`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Pass `--tag alpha` to `changeset publish` in the release script.

  Previous attempt declared `publishConfig.tag = "alpha"` in each
  package's `package.json`. The metadata reached the npm registry,
  but `@changesets/cli publish` overrides it with its own `--tag`
  argument (defaulting to `latest`), so every pre-release after
  `1.0.0-alpha.0` continued to land in the `latest` dist-tag while
  `alpha` stayed pinned to the initial version.

  The fix is a single CLI flag in the root `release` script:

  ```diff
  - "release": "changeset publish"
  + "release": "changeset publish --tag alpha"
  ```

  `changesets/action` invokes this script from the Release workflow,
  so the flag propagates to every package in the same publish run.
  The previously-added `publishConfig.tag` stays in place as
  declarative metadata for direct `npm publish` callers (where it
  still applies); it will be removed alongside the `--tag alpha`
  flag during `pnpm changeset pre exit` for stable `1.0.0`.

  No functional / API change — release infrastructure only.

- Updated dependencies [[`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9)]:
  - @nestjs-transactional/core@1.0.0-alpha.4

## 1.0.0-alpha.3

### Patch Changes

- [#8](https://github.com/igorgolovanov/nestjs-transactional/pull/8) [`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Pin npm dist-tag to `alpha` while in the pre-release cohort.

  Each package's `publishConfig` now declares `"tag": "alpha"`, so
  `npm publish` (driven by `changesets/action` from the Release
  workflow) places every pre-release into the `alpha` dist-tag instead
  of `latest`. Previously the `release` script (`changeset publish`)
  did not pass `--tag`, and changesets does not infer the pre-release
  tag automatically — so the second and every subsequent
  pre-release publish wrote the new version into `latest`, leaving
  the `alpha` tag pointing at `1.0.0-alpha.0` while `latest` advanced
  to the freshest pre-release. That was already the case on
  `@nestjs-transactional/typeorm` and `@nestjs-transactional/outbox-typeorm`
  after the TypeORM 1.0 bump (`1.0.0-alpha.0` → `1.0.0-alpha.1`) and on
  `@nestjs-transactional/cqrs` after ADR-020 (`1.0.0-alpha.0` →
  `1.0.0-alpha.2`); manual `npm dist-tag` runs corrected the registry.

  `publishConfig.tag` is declarative per-package and survives
  `changesets/action` updates without changes to the release workflow
  or root scripts. The setting will be removed (or flipped to `latest`)
  as part of the `pnpm changeset pre exit` step before promoting the
  cohort to stable `1.0.0`.

  No functional change to any package's runtime behaviour or public
  API — `package.json` metadata only.

- Updated dependencies [[`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035)]:
  - @nestjs-transactional/core@1.0.0-alpha.3

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  Persistent Event Publication Registry — Spring Modulith
  `@ApplicationModuleListener` durability semantics for NestJS.
  - `EventPublication` lifecycle states (`PUBLISHED`, `PROCESSING`,
    `COMPLETED`, `FAILED`, `RESUBMITTED`).
  - `EventPublicationRepository` SPI; `InMemoryEventPublicationRepository`
    shipped for tests.
  - `EventTypeRegistry` for cross-restart deserialization.
  - `OutboxListenerRegistry` and class-level `@OutboxEventsHandler`
    decorator (ADR-014). Stable listener id format
    `${baseId}#${EventName}` for rename safety (ADR-009).
  - `OutboxEventPublisher` — smart facade detecting active dataSource
    via `TransactionContext` (DD-024). Multi-DS routing via per-event
    registry plus explicit override.
  - `EventPublicationProcessor` async worker; `StalenessMonitor`
    detects publications stuck in `PROCESSING`;
    `StartupRecoveryService` republishes on restart.
  - Operator APIs: `FailedEventPublications` (with `resubmit(...)`),
    `IncompleteEventPublications`, `CompletedEventPublications`.
  - Completion modes: `UPDATE`, `DELETE`, `ARCHIVE`.
  - `@Externalized` SPI + `EventExternalizer` structural port (DD-018)
    for broker delivery — concrete implementations in
    `@nestjs-transactional/outbox-microservices`.
  - `OutboxModule.forRoot({ ... dataSource? })` /
    `OutboxModule.forFeature(events, { dataSource? })` — multi-`forRoot`
    pattern (ADR-019); per-DS event-type registries; static-class
    storage coordinates singletons across calls.
  - `OutboxProcessingModule` for worker processes.
  - `/testing` subpath: `PublishedEvents` and
    `AssertablePublishedEvents` mirror Spring Modulith's helpers.

  Peer deps: `@nestjs-transactional/core`. Persistence backends ship
  separately (`outbox-typeorm`); the in-memory repo is sufficient for
  unit tests. Public alpha.

### Patch Changes

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
