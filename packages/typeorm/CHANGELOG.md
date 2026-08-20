# @nestjs-transactional/typeorm

## 1.0.0

### Minor Changes

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

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  TypeORM adapter for `@nestjs-transactional/core`:
  - `TypeOrmTransactionAdapter` — implements the core
    `TransactionAdapter` SPI over `DataSource.transaction(...)`. Issues
    raw `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT`
    SQL for `NESTED` propagation. Compatible with Postgres, MySQL,
    MariaDB, SQLite, and Oracle savepoint identifier limits.
  - **Transparent transactional repositories (Phase 14.20)** —
    `@InjectRepository(Entity)` Repositories automatically dispatch
    through the active `@Transactional()` scope's `EntityManager`. No
    `getCurrentEntityManager()` calls in user service code. Covers
    `repo.save(...)`, all 30+ Repository operations, custom
    `Repository.extend(...)` classes, `TreeRepository`, plus
    `@InjectEntityManager() em.getRepository(E).save(...)` and
    `@InjectDataSource() ds.getRepository(E).save(...)` patterns.
  - `getCurrentEntityManager(adapterInstance?, fallback?)` and
    `isInTransaction(adapterInstance?)` escape-hatch helpers for the
    documented limitations (`@InjectEntityManager() em.save(...)`
    direct call, `BaseEntity.useDataSource` static API).
  - `TypeOrmTransactionalModule.forRoot({ dataSource?, isDefault? })`
    and `forRootAsync({...})` — multi-`forRoot` per dataSource (ADR-018);
    the underlying `DataSource` resolves from DI under
    `getDataSourceToken(name)` matching `@nestjs/typeorm` conventions.

  Peer deps: `@nestjs-transactional/core`, `typeorm ^0.3.25`,
  `@nestjs/typeorm ^10.0.0 || ^11.0.0`. Public alpha.

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

- [#15](https://github.com/igorgolovanov/nestjs-transactional/pull/15) [`6c04921`](https://github.com/igorgolovanov/nestjs-transactional/commit/6c04921050d5d513c3986ebedb3ed3a6cdca466d) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - `PropagationMode.NESTED` now fails with a useful error on drivers that
  cannot do savepoints.

  `runInSavepoint` used to emit raw `SAVEPOINT` SQL unconditionally. On SQL
  Server, SAP HANA, MongoDB, Spanner or Cordova the driver rejects that
  statement, so the user got an opaque driver-level error that says nothing
  about `NESTED` propagation being the cause — while the
  `TransactionAdapter` contract has always specified
  `IllegalTransactionStateError` for exactly this case.

  The adapter now checks the capability first and throws that error,
  naming the driver, the capability TypeORM reported, and the propagation
  modes to reach for instead (`REQUIRED` to join the caller's transaction,
  `REQUIRES_NEW` for an independent one). The callback is not invoked, so
  there is no half-executed nested block.

  No dialect allowlist was added — TypeORM reports the capability itself
  via `driver.transactionSupport`, which is `'nested'` for the
  savepoint-capable drivers (Postgres, MySQL, Oracle, SQLite, CockroachDB,
  …) and `'simple'` / `'none'` otherwise. The check is deliberately
  permissive when the flag is missing: a TypeORM version that renames or
  drops it must not turn every `NESTED` call into a hard failure, since
  absence of the signal is not evidence of absent support.

  Nothing changes for Postgres, MySQL, SQLite or the other
  savepoint-capable drivers — which is every driver this package's tests
  and examples run against.

  Also adds a contract test suite pinning the TypeORM internals the
  transparent-repository patching layer depends on (plain-assignment
  `manager` in the `Repository` constructor, delegation through
  `this.manager`, `getRepository` on `EntityManager.prototype`, and so on).
  Those patches fail silently when an internal shape moves — repositories
  quietly run on their own autocommit connection instead of the
  transaction — so the suite asserts the substrate directly and names the
  file to revisit when an assumption breaks.

### Patch Changes

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

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  TypeORM adapter for `@nestjs-transactional/core`:
  - `TypeOrmTransactionAdapter` — implements the core
    `TransactionAdapter` SPI over `DataSource.transaction(...)`. Issues
    raw `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT`
    SQL for `NESTED` propagation. Compatible with Postgres, MySQL,
    MariaDB, SQLite, and Oracle savepoint identifier limits.
  - **Transparent transactional repositories (Phase 14.20)** —
    `@InjectRepository(Entity)` Repositories automatically dispatch
    through the active `@Transactional()` scope's `EntityManager`. No
    `getCurrentEntityManager()` calls in user service code. Covers
    `repo.save(...)`, all 30+ Repository operations, custom
    `Repository.extend(...)` classes, `TreeRepository`, plus
    `@InjectEntityManager() em.getRepository(E).save(...)` and
    `@InjectDataSource() ds.getRepository(E).save(...)` patterns.
  - `getCurrentEntityManager(adapterInstance?, fallback?)` and
    `isInTransaction(adapterInstance?)` escape-hatch helpers for the
    documented limitations (`@InjectEntityManager() em.save(...)`
    direct call, `BaseEntity.useDataSource` static API).
  - `TypeOrmTransactionalModule.forRoot({ dataSource?, isDefault? })`
    and `forRootAsync({...})` — multi-`forRoot` per dataSource (ADR-018);
    the underlying `DataSource` resolves from DI under
    `getDataSourceToken(name)` matching `@nestjs/typeorm` conventions.

  Peer deps: `@nestjs-transactional/core`, `typeorm ^0.3.25`,
  `@nestjs/typeorm ^10.0.0 || ^11.0.0`. Public alpha.

### Patch Changes

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/core@1.0.0-alpha.0
