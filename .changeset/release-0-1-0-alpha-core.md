---
'@nestjs-transactional/core': minor
---

First public alpha release.

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
