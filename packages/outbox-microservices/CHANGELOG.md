# @nestjs-transactional/outbox-microservices

## 1.0.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  Event externalization to message brokers via `@nestjs/microservices`
  `ClientProxy` — Spring Modulith `@Externalized` parity collapsed
  into one package covering every transport the upstream supports
  (Kafka, RabbitMQ, NATS, JMS, gRPC, custom). Architectural rationale
  in ADR-015.
  - `MicroservicesEventExternalizer` plugs into
    `@nestjs-transactional/outbox` as the `EventExternalizer`
    implementation. The processor invokes it AFTER local listeners
    succeed; if either step fails the publication finalises as
    `FAILED` and surfaces in `FailedEventPublications.resubmit`
    (DD-019 single-unit atomicity).
  - `OutboxMicroservicesModule.forRoot({ defaultClient })` /
    `forRootAsync({...})` reuses the application's existing
    `ClientsModule` registration (DD-017 — no parallel connection
    pool, no second mental model). Per-event broker routing via
    `@Externalized({ client })`.
  - Module is `@Global()` so the bound `EVENT_EXTERNALIZER` is visible
    to every per-DS outbox processor without explicit imports —
    multi-DataSource setups need no special wiring.
  - `validateOnBootstrap: true` (default) resolves the
    `defaultClient` once at `OnApplicationBootstrap` and throws a
    descriptive error if the token is unbound.

  ⚠️ **Reliability semantics — read [ADR-016] before production use.**
  The `@nestjs/microservices` `ClientProxy.emit()` API does NOT
  propagate broker-side delivery failures; the externalizer reports
  success when the dispatch is handed off to the transport, not when
  the broker durably acknowledges. Mitigation strategies (idempotent
  producers, consumer-side inbox / dedup, broker-aware externalizers)
  documented in `packages/outbox-microservices/README.md` and
  demonstrated in `examples/externalization-with-fallback`.

  [ADR-016]: https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/016-externalization-reliability-semantics.md

  Peer deps: `@nestjs-transactional/core`, `@nestjs-transactional/outbox`,
  `@nestjs/microservices`. Public alpha.

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

- Updated dependencies [[`31d9de4`](https://github.com/igorgolovanov/nestjs-transactional/commit/31d9de4ca35f69f8b384229f8c38bc13fe9a67dd), [`f9ff0b6`](https://github.com/igorgolovanov/nestjs-transactional/commit/f9ff0b67f38220958c6a486d09e6766c60ea18c5), [`4c84e2d`](https://github.com/igorgolovanov/nestjs-transactional/commit/4c84e2df45aafdc1448fe27214ca2082abe0b86b), [`6c3b21f`](https://github.com/igorgolovanov/nestjs-transactional/commit/6c3b21fa7e9ed4ec149fd22c6cff21e598b2b73f), [`f4f7aea`](https://github.com/igorgolovanov/nestjs-transactional/commit/f4f7aea7d8d5cf11bcbc443d4b0b422cb0bdf19d), [`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035), [`1b010e4`](https://github.com/igorgolovanov/nestjs-transactional/commit/1b010e4424462aba825ae782b44b4771f4e4491b), [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1), [`382ded3`](https://github.com/igorgolovanov/nestjs-transactional/commit/382ded3ae8c46ed74831ad6665fa1b5062624212), [`8e5b9fa`](https://github.com/igorgolovanov/nestjs-transactional/commit/8e5b9fadcafa9ffec377d02e86c493a5eb7797a9), [`88b9ca5`](https://github.com/igorgolovanov/nestjs-transactional/commit/88b9ca5a8fef43ba221982425c518d6cd2db350b), [`f134d8a`](https://github.com/igorgolovanov/nestjs-transactional/commit/f134d8afbef9c715f2ffcfef76ce4b8dd10f31ef)]:
  - @nestjs-transactional/outbox@1.0.0

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
  - @nestjs-transactional/outbox@1.0.0-alpha.3

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  Event externalization to message brokers via `@nestjs/microservices`
  `ClientProxy` — Spring Modulith `@Externalized` parity collapsed
  into one package covering every transport the upstream supports
  (Kafka, RabbitMQ, NATS, JMS, gRPC, custom). Architectural rationale
  in ADR-015.
  - `MicroservicesEventExternalizer` plugs into
    `@nestjs-transactional/outbox` as the `EventExternalizer`
    implementation. The processor invokes it AFTER local listeners
    succeed; if either step fails the publication finalises as
    `FAILED` and surfaces in `FailedEventPublications.resubmit`
    (DD-019 single-unit atomicity).
  - `OutboxMicroservicesModule.forRoot({ defaultClient })` /
    `forRootAsync({...})` reuses the application's existing
    `ClientsModule` registration (DD-017 — no parallel connection
    pool, no second mental model). Per-event broker routing via
    `@Externalized({ client })`.
  - Module is `@Global()` so the bound `EVENT_EXTERNALIZER` is visible
    to every per-DS outbox processor without explicit imports —
    multi-DataSource setups need no special wiring.
  - `validateOnBootstrap: true` (default) resolves the
    `defaultClient` once at `OnApplicationBootstrap` and throws a
    descriptive error if the token is unbound.

  ⚠️ **Reliability semantics — read [ADR-016] before production use.**
  The `@nestjs/microservices` `ClientProxy.emit()` API does NOT
  propagate broker-side delivery failures; the externalizer reports
  success when the dispatch is handed off to the transport, not when
  the broker durably acknowledges. Mitigation strategies (idempotent
  producers, consumer-side inbox / dedup, broker-aware externalizers)
  documented in `packages/outbox-microservices/README.md` and
  demonstrated in `examples/externalization-with-fallback`.

  [ADR-016]: https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/016-externalization-reliability-semantics.md

  Peer deps: `@nestjs-transactional/core`, `@nestjs-transactional/outbox`,
  `@nestjs/microservices`. Public alpha.

### Patch Changes

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/outbox@1.0.0-alpha.0
