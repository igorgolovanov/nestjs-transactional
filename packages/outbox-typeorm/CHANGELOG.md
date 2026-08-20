# @nestjs-transactional/outbox-typeorm

## 1.0.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First stable release.

  TypeORM persistence backend for `@nestjs-transactional/outbox`:
  - `EventPublicationEntity` (`event_publication` hot table) with four
    worker / operator / cleanup indexes:
    `(status, publicationDate)`, `(status, listenerId)`, `(eventType)`,
    `(completionDate)`. `status` is `varchar(32)` (not Postgres `enum`)
    to keep new lifecycle states from forcing a type migration.
  - `EventPublicationArchiveEntity` (`event_publication_archive`) for
    the `ARCHIVE` completion mode — same columns minus the nullability
    of `completionDate`.
  - `TypeOrmEventPublicationRepository` implementing the SPI:
    - `findReadyForProcessing` uses
      `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent worker
      safety.
    - `tryClaim` issues a single conditional `UPDATE` for atomic
      `PUBLISHED|RESUBMITTED → PROCESSING` transitions.
    - All reads/writes go through `getCurrentEntityManager` so
      publication rows commit atomically with the business write
      (DD-019 single-unit atomicity).
  - `OutboxTypeOrmModule.forRoot({ dataSource?, schemaInitialization?, isGlobal? })`
    and `forRootAsync({...})` — Phase 14.21 reshape mirroring
    `TypeOrmTransactionalModule.forRoot`. The underlying `DataSource`
    resolves from DI via `getDataSourceToken(name)`.
  - Cross-module bridge `typeOrmEventPublicationRepositoryProvider({ dataSource? })`
    forwarding the per-DS repository token to the `outbox` package.
  - Schema management: shipped TypeORM migration
    `CreateEventPublication1700000000000` for production (preferred);
    `SchemaInitializer` for development-time auto-init at bootstrap.

  Peer deps: `@nestjs-transactional/core`, `@nestjs-transactional/typeorm`,
  `@nestjs-transactional/outbox`, `typeorm ^0.3.25`,
  `@nestjs/typeorm ^10.0.0 || ^11.0.0`. The public API is covered by the stability policy in ADR-004.

- [#4](https://github.com/igorgolovanov/nestjs-transactional/pull/4) [`60872c3`](https://github.com/igorgolovanov/nestjs-transactional/commit/60872c32aae289e161382b01832c2be019d74536) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Support TypeORM 1.0 alongside 0.3.x.

  The TypeORM peer-dependency range is widened to
  `^0.3.0 || ^1.0.0`, covering the stable `0.3.x` and `1.x` lines.
  TypeORM nightly / beta pre-release channels stay outside the
  declared range; consumers who need them can install through
  `pnpm.overrides`.

  Internal compatibility: the patching layer reads the owning
  `DataSource` from an `EntityManager` through a small helper
  (`getEmDataSource`) that handles the 0.3.x → 1.0 rename
  (`EntityManager.connection` → `EntityManager.dataSource`). All
  other touchpoints (`QueryRunner`, schema-builder `Table` /
  `TableIndex`, `MigrationInterface`, ORM decorators) are
  behaviourally unchanged across the two majors. CI now runs the
  full unit + integration matrix on both TypeORM versions.

  `engines.node` for these two packages is bumped to `>=22.13.0`
  to match TypeORM 1.0's minimum on the Node 22 line.

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

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`480d908`](https://github.com/igorgolovanov/nestjs-transactional/commit/480d9082510d9fd991db35aa5bce06a16c60582c) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - TypeORM 1.1.0 is now the version the adapters are developed and tested
  against.

  **The peer range is unchanged** — `^0.3.0 || ^1.0.0` already admitted
  `1.1.0`, so no consumer needs to do anything. What changes is that the
  version is now verified rather than merely permitted: the workspace
  lockfile pins `1.1.0`, and CI runs the full unit and integration matrix
  (testcontainers Postgres) against three explicit points of the range —
  `0.3.31` (newest `0.3.x`), `1.0.0` (the floor of `^1.0.0`) and `1.1.0`.

  The upgrade needed no production-code changes. TypeORM 1.1.0 is a minor
  release with no breaking changes, and the assumptions the adapter relies
  on held: the prototype-patching contract tests, the
  `driver.transactionSupport` capability check behind
  `PropagationMode.NESTED`, and `SET TRANSACTION READ ONLY` all pass
  unchanged on `0.3.31`, `1.0.0` and `1.1.0`.

  Two related fixes on the way there:
  - CI's matrix legs used to derive the `0.3` version from the lockfile
    rather than stating it, so bumping the lockfile would have turned that
    leg into a duplicate of another without anyone noticing. Every leg now
    names its version, and a post-install step asserts the version that
    actually resolved — `pnpm.overrides` in `package.json` is silently
    ignored by pnpm 10, and a silently-ignored override would leave the leg
    claiming a compatibility it never exercised.
  - `@nestjs-transactional/cqrs` used `typeorm`, `@nestjs/typeorm`,
    `@nestjs/testing` and `@nestjs-transactional/typeorm` in its specs
    without declaring any of them, resolving them through the workspace's
    `public-hoist-pattern` instead. That worked only while every package
    happened to resolve the same TypeORM copy; with two versions in the
    tree its E2E suite injected a `DataSource` class from one copy and
    looked it up from another. Development-only, no effect on the
    published package.

- Updated dependencies [[`31d9de4`](https://github.com/igorgolovanov/nestjs-transactional/commit/31d9de4ca35f69f8b384229f8c38bc13fe9a67dd), [`f9ff0b6`](https://github.com/igorgolovanov/nestjs-transactional/commit/f9ff0b67f38220958c6a486d09e6766c60ea18c5), [`4c84e2d`](https://github.com/igorgolovanov/nestjs-transactional/commit/4c84e2df45aafdc1448fe27214ca2082abe0b86b), [`6c3b21f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6c3b21fa7e9ed4ec149fd22c6cff21e598b2b73f), [`f4f7aea`](https://github.com/igorgolovanov/nestjs-transactional/commit/f4f7aea7d8d5cf11bcbc443d4b0b422cb0bdf19d), [`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035), [`1b010e4`](https://github.com/igorgolovanov/nestjs-transactional/commit/1b010e4424462aba825ae782b44b4771f4e4491b), [`a33ba73`](https://github.com/igorgolovanov/nestjs-transactional/commit/a33ba733cf67662ed9fa4bb34d6a82b2144474f7), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`382ded3`](https://github.com/igorgolovanov/nestjs-transactional/commit/382ded3ae8c46ed74831ad6665fa1b5062624212), [`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9), [`88b9ca5`](https://github.com/igorgolovanov/nestjs-transactional/commit/88b9ca5a8fef43ba221982425c518d6cd2db350b), [`f134d8a`](https://github.com/igorgolovanov/nestjs-transactional/commit/f134d8afbef9c715f2ffcfef76ce4b8dd10f31ef), [`480d908`](https://github.com/igorgolovanov/nestjs-transactional/commit/480d9082510d9fd991db35aa5bce06a16c60582c), [`60872c3`](https://github.com/igorgolovanov/nestjs-transactional/commit/60872c32aae289e161382b01832c2be019d74536), [`6c04921`](https://github.com/igorgolovanov/nestjs-transactional/commit/6c04921050d5d513c3986ebedb3ed3a6cdca466d)]:
  - @nestjs-transactional/core@1.0.0
  - @nestjs-transactional/outbox@1.0.0
  - @nestjs-transactional/typeorm@1.0.0

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
  - @nestjs-transactional/typeorm@1.0.0-alpha.5
  - @nestjs-transactional/outbox@1.0.0-alpha.5

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
  - @nestjs-transactional/typeorm@1.0.0-alpha.4
  - @nestjs-transactional/outbox@1.0.0-alpha.4

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
  - @nestjs-transactional/typeorm@1.0.0-alpha.3
  - @nestjs-transactional/outbox@1.0.0-alpha.3

## 1.0.0-alpha.1

### Minor Changes

- [#4](https://github.com/igorgolovanov/nestjs-transactional/pull/4) [`60872c3`](https://github.com/igorgolovanov/nestjs-transactional/commit/60872c32aae289e161382b01832c2be019d74536) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Support TypeORM 1.0 alongside 0.3.x.

  The TypeORM peer-dependency range is widened to
  `^0.3.0 || ^1.0.0`, covering the stable `0.3.x` and `1.x` lines.
  TypeORM nightly / beta pre-release channels stay outside the
  declared range; consumers who need them can install through
  `pnpm.overrides`.

  Internal compatibility: the patching layer reads the owning
  `DataSource` from an `EntityManager` through a small helper
  (`getEmDataSource`) that handles the 0.3.x → 1.0 rename
  (`EntityManager.connection` → `EntityManager.dataSource`). All
  other touchpoints (`QueryRunner`, schema-builder `Table` /
  `TableIndex`, `MigrationInterface`, ORM decorators) are
  behaviourally unchanged across the two majors. CI now runs the
  full unit + integration matrix on both TypeORM versions.

  `engines.node` for these two packages is bumped to `>=22.13.0`
  to match TypeORM 1.0's minimum on the Node 22 line.

### Patch Changes

- Updated dependencies [[`60872c3`](https://github.com/igorgolovanov/nestjs-transactional/commit/60872c32aae289e161382b01832c2be019d74536)]:
  - @nestjs-transactional/typeorm@1.0.0-alpha.1

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  TypeORM persistence backend for `@nestjs-transactional/outbox`:
  - `EventPublicationEntity` (`event_publication` hot table) with four
    worker / operator / cleanup indexes:
    `(status, publicationDate)`, `(status, listenerId)`, `(eventType)`,
    `(completionDate)`. `status` is `varchar(32)` (not Postgres `enum`)
    to keep new lifecycle states from forcing a type migration.
  - `EventPublicationArchiveEntity` (`event_publication_archive`) for
    the `ARCHIVE` completion mode — same columns minus the nullability
    of `completionDate`.
  - `TypeOrmEventPublicationRepository` implementing the SPI:
    - `findReadyForProcessing` uses
      `SELECT ... FOR UPDATE SKIP LOCKED` for concurrent worker
      safety.
    - `tryClaim` issues a single conditional `UPDATE` for atomic
      `PUBLISHED|RESUBMITTED → PROCESSING` transitions.
    - All reads/writes go through `getCurrentEntityManager` so
      publication rows commit atomically with the business write
      (DD-019 single-unit atomicity).
  - `OutboxTypeOrmModule.forRoot({ dataSource?, schemaInitialization?, isGlobal? })`
    and `forRootAsync({...})` — Phase 14.21 reshape mirroring
    `TypeOrmTransactionalModule.forRoot`. The underlying `DataSource`
    resolves from DI via `getDataSourceToken(name)`.
  - Cross-module bridge `typeOrmEventPublicationRepositoryProvider({ dataSource? })`
    forwarding the per-DS repository token to the `outbox` package.
  - Schema management: shipped TypeORM migration
    `CreateEventPublication1700000000000` for production (preferred);
    `SchemaInitializer` for development-time auto-init at bootstrap.

  Peer deps: `@nestjs-transactional/core`, `@nestjs-transactional/typeorm`,
  `@nestjs-transactional/outbox`, `typeorm ^0.3.25`,
  `@nestjs/typeorm ^10.0.0 || ^11.0.0`. Public alpha.

### Patch Changes

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
  - @nestjs-transactional/outbox@1.0.0-alpha.0
  - @nestjs-transactional/typeorm@1.0.0-alpha.0
