# @nestjs-transactional/core

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

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  The adapter-agnostic foundation of `@nestjs-transactional`:
  - `TransactionContext` — `AsyncLocalStorage`-backed carrier propagating
    the active transaction across `await` boundaries.
  - `TransactionManager` — runtime with the full Spring propagation
    semantics (`REQUIRED`, `REQUIRES_NEW`, `NESTED`, `SUPPORTS`,
    `NOT_SUPPORTED`, `NEVER`, `MANDATORY`), `rollbackFor` /
    `noRollbackFor` rules, and before/after commit/rollback hooks.
  - `@Transactional()` / `@ReadOnly()` / `@TransactionalOn(instance)`
    decorators — metadata-only, wrapping done at runtime per ADR-005.
  - `TransactionalInterceptor` for the controller / resolver / gateway
    / microservice request boundary; `TransactionalMethodsBootstrap`
    for service-level wrapping via `DiscoveryService`.
  - `TransactionAdapter<THandle>` SPI for ORM-specific adapters.
  - `TransactionalModule.forRoot` / `forRootAsync` (multi-`forRoot`
    pattern per ADR-018 — one call per dataSource).
  - `InMemoryTransactionAdapter` via the `/testing` subpath for
    adapter-level observability in unit tests.

  Public alpha — API may change between 0.x releases. Install
  `@nestjs-transactional/typeorm` for TypeORM integration or implement
  your own adapter against the `TransactionAdapter` interface.
