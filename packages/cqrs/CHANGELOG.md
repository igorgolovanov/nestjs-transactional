# @nestjs-transactional/cqrs

## 1.0.0

### Minor Changes

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`9a3d372`](https://github.com/igorgolovanov/nestjs-transactional/commit/9a3d372178a0b3d8f0aef5cac40eaa6cbcc3362a) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - `CqrsTransactionalModule.forRootAsync` for config that only exists at
  runtime, plus a documented rationale for the `@nestjs/cqrs` peer range.

  Core and typeorm already had `forRootAsync`; cqrs did not, which made it
  the one module you could not configure from a `ConfigService`. It now
  mirrors the shape the other two use — structural flags on the options
  object, value-shaped config from the factory:

  ```ts
  CqrsTransactionalModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (cfg: ConfigService) => ({
      wrapQueryHandlers: cfg.get('WRAP_QUERIES') !== 'false',
      defaultCommandOptions: { isolation: cfg.get('TX_ISOLATION') },
    }),
  });
  ```

  `useTransactionalEventPublisher` stays on the options object rather than
  the factory result: it decides whether the `EventPublisher` override
  provider is registered at all, and NestJS needs provider tokens at
  module-definition time, before any async factory has run. That is the
  same split `OutboxModule.forRootAsync` uses for `repository`.

  Both paths share one defaults resolver and one provider-matrix builder,
  so they cannot drift apart — a spec asserts the two produce identical
  exports and provider counts. The `exports: exportTokens as never[]` cast
  on the returned module is gone, replaced by a typed `InjectionToken[]`.

  Also documented, not changed: the `@nestjs/cqrs: ^11.0.0` peer stays
  narrower than the `^10 || ^11` used elsewhere in this monorepo, and the
  reason is now in the package README. The handler-wrapping mechanism
  itself would work on `@nestjs/cqrs@10` — the metadata constants it reads
  are identical across both majors — but `AsyncContext` is a v11 addition
  and it is what makes the documented request-scoped handler support work.
  `@nestjs/cqrs@10` also peers on `@nestjs/common ^9 || ^10`, so anyone
  pinned to it is on NestJS 10 anyway.

- [#6](https://github.com/igorgolovanov/nestjs-transactional/pull/6) [`d9c80d3`](https://github.com/igorgolovanov/nestjs-transactional/commit/d9c80d38e238da9e593bcecbbfb4a7ea7f82c18b) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Lift the singleton-handler restriction in `CqrsHandlerWrapper`.

  `@CommandHandler` / `@QueryHandler` / `@EventsHandler` classes
  declared with `{ scope: Scope.REQUEST }` or
  `{ scope: Scope.TRANSIENT }` now compose with `@Transactional` —
  including the common request-scoped pattern where the handler
  injects `@nestjs/cqrs`'s `AsyncContext` via `@Inject(REQUEST)` to
  carry per-request data (user, geo, A/B flags, ...).

  The wrap target moved from the resolved handler **instance** to the
  handler class **prototype**, intercepting `@nestjs/cqrs`'s
  late-bound `instance.execute(query)` / `instance.handle(event)`
  lookup regardless of how the instance is resolved. The
  `@Transactional` decorator surface, propagation modes, defaults
  (`defaultQueryOptions`, `defaultCommandOptions`), event-dispatcher
  semantics, and the `WRAPPED_MARKER` double-wrap protection are
  unchanged. Singleton handlers behave identically.

  A test-isolation API ships alongside:
  `CqrsHandlerWrapper.resetForTesting()` static restores wrapped
  prototypes between cases. `CqrsHandlerWrapper` also implements
  `OnModuleDestroy` and calls the same cleanup automatically on
  `module.close()`, so existing test suites do not need a per-`it`
  reset to stay green.

  Rationale and full design: see [ADR-020](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/020-prototype-level-cqrs-wrapping.md).

  Known edge case: handlers defined with an arrow-function instance
  field (`execute = async (q) => {...}`) are not wrapped — the
  method shadows the prototype. Use regular method syntax
  (`async execute(q) { ... }`) so the method lives on the prototype.

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

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First stable release.

  `@nestjs/cqrs` integration without forking it (ADR-003):
  - `@TransactionalEventsHandler` — class-level event handler decorator
    with Spring-compatible phases (`BEFORE_COMMIT`, `AFTER_COMMIT`
    default, `AFTER_ROLLBACK`, `AFTER_COMPLETION`). Implements
    `ITransactionalEventHandler<T>` with a single `handle(event)` method.
    Matches `@nestjs/cqrs`'s own `@EventsHandler` ergonomics (ADR-014).
  - `@IntegrationEventsHandler` — class-level smart default for
    cross-module handlers. Delivers via the outbox when the
    `OUTBOX_LISTENER_REGISTRAR` structural port is bound (durable,
    retried, resumable); falls back to in-memory `AFTER_COMMIT` +
    `async: true` dispatch otherwise. Spring Modulith
    `@ApplicationModuleListener` parity.
  - `TransactionalEventPublisher` + adapter — drop-in replacement for
    `@nestjs/cqrs`'s `EventPublisher`. `AggregateRoot.commit()` events
    attach as phase hooks on the active transaction; no more "event
    published, transaction rolled back" race.
  - `HybridEventPublisher` — strategy wired by
    `CqrsTransactionalModule.forRoot()`. Routes `aggregate.commit()`
    through the in-memory dispatcher AND, when an outbox scheduler is
    bound to `OUTBOX_PUBLICATION_SCHEDULER`, also through
    `@nestjs-transactional/outbox` for durable delivery.
  - `CqrsHandlerWrapper` + `CqrsTransactionalBootstrap` — bootstrap-time
    wrapping of every `@CommandHandler` / `@QueryHandler` /
    `@EventsHandler` carrying `@Transactional()` metadata.
  - Multi-DataSource support (Phase 14.3.1 Category B) —
    `@TransactionalEventsHandler({ events, dataSource })` pins handlers
    to a specific dataSource's transaction context.
  - `CqrsTransactionalModule.forRoot({...})` single entry point.

  Peer deps: `@nestjs-transactional/core`, `@nestjs/cqrs ^11.0.0`.
  The public API is covered by the stability policy in ADR-004.

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

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`a33ba73`](https://github.com/igorgolovanov/nestjs-transactional/commit/a33ba733cf67662ed9fa4bb34d6a82b2144474f7) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - `readOnly` is now enforced by the database on Postgres-family dialects.

  `TransactionOptions.readOnly` had been declared since the core package
  shipped but never honoured — `@ReadOnly()` and
  `CqrsTransactionalModule`'s `defaultQueryOptions: { readOnly: true }`
  default documented intent while a stray write committed anyway.
  `TypeOrmTransactionAdapter` now issues `SET TRANSACTION READ ONLY` as the
  transaction's first statement on `postgres`, `cockroachdb` and
  `aurora-postgres`, so the write is refused by the database instead.

  **It is a hint, and the enforcement is per-dialect.** On every other
  dialect the flag remains a silent no-op. That is deliberate on both
  counts:
  - MySQL and MariaDB are not implementable, not merely unimplemented.
    `SET TRANSACTION` there applies to the _next_ transaction and raises
    `ERROR 1568` inside a started one; read-only has to be given as
    `START TRANSACTION READ ONLY`, a moment TypeORM never exposes.
  - Silent rather than throwing, because the cqrs module defaults every
    query handler to `readOnly: true` — erroring would break every MySQL
    and SQLite consumer over an option they never set.

  So the same code enforces on Postgres and does not on MySQL or SQLite.
  That difference is documented in `known-limitations.md` and in the
  option's JSDoc; it is worth knowing if you develop against SQLite and
  deploy to Postgres. This also matches Spring, where `readOnly` is
  explicitly a hint — its real benefit there comes from Hibernate's
  `FlushMode.MANUAL`, which has no TypeORM analogue since TypeORM has no
  unit of work to skip dirty-checking on.

  `readOnly` applies only when the adapter _starts_ the transaction: a
  `REQUIRED` call joining an existing read-write transaction cannot make it
  read-only after the fact. Spring behaves the same way.

  **`timeout` remains unimplemented, and deliberately not approximated.**
  TypeORM exposes no transaction-level timeout, and Postgres'
  `statement_timeout` bounds each statement rather than the transaction —
  `timeout: 5000` on a method issuing four queries would allow twenty
  seconds, not five. The option stays in the type surface as the extension
  point for adapters whose driver has a real transaction budget; Prisma's
  `$transaction` accepts exactly that.

  Rationale and the alternatives weighed:
  [DD-027](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/027-readonly-and-timeout-semantics.md).

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

## 1.0.0-alpha.2

### Minor Changes

- [#6](https://github.com/igorgolovanov/nestjs-transactional/pull/6) [`d9c80d3`](https://github.com/igorgolovanov/nestjs-transactional/commit/d9c80d38e238da9e593bcecbbfb4a7ea7f82c18b) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Lift the singleton-handler restriction in `CqrsHandlerWrapper`.

  `@CommandHandler` / `@QueryHandler` / `@EventsHandler` classes
  declared with `{ scope: Scope.REQUEST }` or
  `{ scope: Scope.TRANSIENT }` now compose with `@Transactional` —
  including the common request-scoped pattern where the handler
  injects `@nestjs/cqrs`'s `AsyncContext` via `@Inject(REQUEST)` to
  carry per-request data (user, geo, A/B flags, ...).

  The wrap target moved from the resolved handler **instance** to the
  handler class **prototype**, intercepting `@nestjs/cqrs`'s
  late-bound `instance.execute(query)` / `instance.handle(event)`
  lookup regardless of how the instance is resolved. The
  `@Transactional` decorator surface, propagation modes, defaults
  (`defaultQueryOptions`, `defaultCommandOptions`), event-dispatcher
  semantics, and the `WRAPPED_MARKER` double-wrap protection are
  unchanged. Singleton handlers behave identically.

  A test-isolation API ships alongside:
  `CqrsHandlerWrapper.resetForTesting()` static restores wrapped
  prototypes between cases. `CqrsHandlerWrapper` also implements
  `OnModuleDestroy` and calls the same cleanup automatically on
  `module.close()`, so existing test suites do not need a per-`it`
  reset to stay green.

  Rationale and full design: see [ADR-020](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/020-prototype-level-cqrs-wrapping.md).

  Known edge case: handlers defined with an arrow-function instance
  field (`execute = async (q) => {...}`) are not wrapped — the
  method shadows the prototype. Use regular method syntax
  (`async execute(q) { ... }`) so the method lives on the prototype.

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  `@nestjs/cqrs` integration without forking it (ADR-003):
  - `@TransactionalEventsHandler` — class-level event handler decorator
    with Spring-compatible phases (`BEFORE_COMMIT`, `AFTER_COMMIT`
    default, `AFTER_ROLLBACK`, `AFTER_COMPLETION`). Implements
    `ITransactionalEventHandler<T>` with a single `handle(event)` method.
    Matches `@nestjs/cqrs`'s own `@EventsHandler` ergonomics (ADR-014).
  - `@IntegrationEventsHandler` — class-level smart default for
    cross-module handlers. Delivers via the outbox when the
    `OUTBOX_LISTENER_REGISTRAR` structural port is bound (durable,
    retried, resumable); falls back to in-memory `AFTER_COMMIT` +
    `async: true` dispatch otherwise. Spring Modulith
    `@ApplicationModuleListener` parity.
  - `TransactionalEventPublisher` + adapter — drop-in replacement for
    `@nestjs/cqrs`'s `EventPublisher`. `AggregateRoot.commit()` events
    attach as phase hooks on the active transaction; no more "event
    published, transaction rolled back" race.
  - `HybridEventPublisher` — strategy wired by
    `CqrsTransactionalModule.forRoot()`. Routes `aggregate.commit()`
    through the in-memory dispatcher AND, when an outbox scheduler is
    bound to `OUTBOX_PUBLICATION_SCHEDULER`, also through
    `@nestjs-transactional/outbox` for durable delivery.
  - `CqrsHandlerWrapper` + `CqrsTransactionalBootstrap` — bootstrap-time
    wrapping of every `@CommandHandler` / `@QueryHandler` /
    `@EventsHandler` carrying `@Transactional()` metadata.
  - Multi-DataSource support (Phase 14.3.1 Category B) —
    `@TransactionalEventsHandler({ events, dataSource })` pins handlers
    to a specific dataSource's transaction context.
  - `CqrsTransactionalModule.forRoot({...})` single entry point.

  Peer deps: `@nestjs-transactional/core`, `@nestjs/cqrs ^11.0.0`.
  Public alpha.

### Patch Changes

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
