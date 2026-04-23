# @nestjs-transactional/core

Core primitives for declarative Spring-style transaction management in NestJS.

Provides:

- `TransactionContext` — AsyncLocalStorage wrapper that carries the active transaction across async boundaries.
- `TransactionManager` — runtime with full Spring propagation semantics (REQUIRED, REQUIRES_NEW, NESTED, SUPPORTS, NOT_SUPPORTED, NEVER, MANDATORY).
- `@Transactional()` decorator — metadata only; method wrapping is performed by coordinated mechanisms (see ADR-005 in the repo root).
- `TransactionalInterceptor` — wires `@Transactional` on controllers/resolvers/gateways via `APP_INTERCEPTOR`.
- `TransactionalMethodsBootstrap` — wires `@Transactional` on regular `@Injectable` providers at `OnApplicationBootstrap`.
- `TransactionAdapter<THandle>` port — pure interface for ORM-specific adapters.
- `InMemoryTransactionAdapter` (via `@nestjs-transactional/core/testing`) — adapter-less testing.

This package has no dependency on any concrete ORM. Install `@nestjs-transactional/typeorm` for TypeORM integration.

## Status

Work in progress. Not yet published to npm.
