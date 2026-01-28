# @nestjs-transactional monorepo

## Overview

This repository contains three npm packages that provide Spring Framework-style
declarative transaction management for NestJS applications:

- **@nestjs-transactional/core** — base infrastructure: AsyncLocalStorage context,
  TransactionManager with propagation modes, `@Transactional()` decorator,
  adapter port interfaces. No dependency on any concrete ORM.

- **@nestjs-transactional/typeorm** — TypeORM adapter, helper for retrieving the
  active EntityManager from the current async context, integration with
  `@nestjs/typeorm`.

- **@nestjs-transactional/cqrs** — integration with `@nestjs/cqrs`: runtime
  wrappers for CommandHandler/QueryHandler/EventHandler, the
  `@TransactionalEventsListener` decorator with Spring-like phases
  (BEFORE_COMMIT, AFTER_COMMIT, AFTER_ROLLBACK, AFTER_COMPLETION), and an
  EventPublisher override that integrates with AggregateRoot.

## Mission Statement

Give NestJS applications transaction management on par with Spring Framework:
a declarative `@Transactional`, the full set of propagation modes, support for
multiple DataSources in the same app, and a tight integration with
event-driven paradigms through CQRS with phase-aware listeners.

---

## Technology Stack

- **Runtime**: Node.js 20 LTS (minimum), 22 LTS supported
- **Language**: TypeScript 5.5+ in strict mode
- **Core peer deps**: `@nestjs/common ^10.0.0 || ^11.0.0`,
  `@nestjs/core ^10.0.0 || ^11.0.0`, `reflect-metadata`, `rxjs ^7.0.0`
- **TypeORM peer**: `typeorm ^0.3.25`, `@nestjs/typeorm ^10.0.0 || ^11.0.0`
- **CQRS peer**: `@nestjs/cqrs ^11.0.0`
- **Package manager**: pnpm workspaces
- **Build**: tsc with project references (no bundler — pure TypeScript)
- **Test runner**: Jest + ts-jest
- **Integration tests**: testcontainers-node for a real Postgres
- **Versioning**: Changesets
- **License**: MIT

---

## Monorepo Structure

```
nestjs-transactional-monorepo/
├── packages/
│   ├── core/                          # @nestjs-transactional/core
│   │   ├── src/
│   │   │   ├── types/                 # public types and interfaces
│   │   │   ├── context/               # TransactionContext (AsyncLocalStorage)
│   │   │   ├── manager/               # TransactionManager, AdapterRegistry
│   │   │   ├── decorators/            # @Transactional, aliases
│   │   │   ├── interceptor/           # NestJS interceptor
│   │   │   ├── module/                # TransactionalModule (forRoot/Async)
│   │   │   ├── observability/         # Observer interface, hooks
│   │   │   ├── testing/               # InMemoryTransactionAdapter (exported via /testing)
│   │   │   └── index.ts               # public API
│   │   ├── test/                      # unit tests
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── README.md
│   │
│   ├── typeorm/                       # @nestjs-transactional/typeorm
│   │   ├── src/
│   │   │   ├── adapter/               # TypeOrmTransactionAdapter
│   │   │   ├── helpers/               # getCurrentEntityManager, isInTransaction
│   │   │   ├── module/                # TypeOrmTransactionalModule
│   │   │   └── index.ts
│   │   ├── test/                      # unit + integration tests
│   │   └── ...
│   │
│   └── cqrs/                          # @nestjs-transactional/cqrs
│       ├── src/
│       │   ├── decorators/            # @TransactionalEventsListener
│       │   ├── types/                 # TransactionPhase, metadata
│       │   ├── event-dispatcher/      # TransactionalEventDispatcher
│       │   ├── event-publisher/       # TransactionalEventPublisher (+ adapter)
│       │   ├── handlers/              # CqrsHandlerWrapper, bootstrap, scanner
│       │   ├── module/                # CqrsTransactionalModule
│       │   └── index.ts
│       └── ...
│
├── examples/
│   ├── basic-usage/                   # minimal service with @Transactional
│   ├── multi-datasource/              # working with multiple databases
│   └── cqrs-full-stack/               # full example with CQRS and aggregates
│
├── docs/
│   ├── getting-started.md
│   ├── architecture/
│   │   ├── core-design.md
│   │   ├── typeorm-adapter.md
│   │   └── cqrs-integration.md
│   └── adr/                           # Architecture Decision Records
│       ├── 001-async-local-storage.md
│       ├── 002-transactional-events-spring-semantics.md
│       ├── 003-not-patching-nestjs-cqrs.md
│       ├── 004-public-api-stability.md
│       └── 005-method-wrapping-strategy.md
│
├── CLAUDE.md                          # this file
├── README.md
├── package.json                       # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json                 # shared TS settings
├── tsconfig.json                      # solution-style root (project references)
├── jest.config.base.js
├── .eslintrc.js
├── .prettierrc
└── .gitignore
```

---

## Architecture Decision Records

Formal records for architectural decisions that need more room than the
Design Decisions section below:

- **ADR-001**: AsyncLocalStorage foundation — `docs/adr/001-async-local-storage.md`
- **ADR-002**: Transactional events with Spring semantics — `docs/adr/002-transactional-events-spring-semantics.md`
- **ADR-003**: Not patching @nestjs/cqrs — `docs/adr/003-not-patching-nestjs-cqrs.md`
- **ADR-004**: Public API stability policy — `docs/adr/004-public-api-stability.md`
- **ADR-005**: Method wrapping strategy — `docs/adr/005-method-wrapping-strategy.md`

Process: every significant architectural decision gets a new ADR numbered n+1.
The discussion is captured; the status is one of accepted / rejected /
superseded. An accepted ADR can only be changed by a new ADR that references
it with `supersedes NNN`.

---

## Architectural Principles

### 1. Hexagonal architecture (ports and adapters)

The core package defines **ports** — interfaces. Separate packages implement
**adapters** — concrete implementations. Core knows nothing about any
specific ORM.

```
@nestjs-transactional/core
└── defines: TransactionAdapter (port)
         ↑
         │ implements
         │
@nestjs-transactional/typeorm
└── TypeOrmTransactionAdapter (adapter)
```

This lets us add more adapters in the future (Prisma, Drizzle, Kysely,
MikroORM) without touching core.

### 2. Layered dependencies

Dependency layers are strict, top to bottom:

```
@nestjs-transactional/cqrs
        ↓ depends on
@nestjs-transactional/typeorm (optional — cqrs also works without typeorm)
        ↓ depends on
@nestjs-transactional/core
        ↓ depends on
NestJS platform + Node builtins
```

**Important**: core does NOT import TypeORM, typeorm does NOT import
@nestjs/cqrs. Reverse dependencies are forbidden.

### 3. AsyncLocalStorage instead of ThreadLocal

Node.js has no ThreadLocal (unlike Java). Instead we use `AsyncLocalStorage`
from `node:async_hooks`. It propagates context correctly across async
boundaries (await, promises, I/O callbacks).

This is the foundation of the whole module. All transaction-context work
goes through `TransactionContext` — a thin wrapper around AsyncLocalStorage.

### 4. Spring @Transactional semantics

`@Transactional()` behavior is modeled on Spring Framework:

- **Propagation modes**: REQUIRED (default), REQUIRES_NEW, NESTED, SUPPORTS,
  NOT_SUPPORTED, NEVER, MANDATORY
- **Isolation levels**: READ_UNCOMMITTED, READ_COMMITTED, REPEATABLE_READ,
  SERIALIZABLE
- **Rollback rules**: `rollbackFor` and `noRollbackFor` for selective rollback
- **Read-only flag**: a hint for optimization
- **Timeout**: optional

Users coming from Spring should feel at home.

### 5. Spring @TransactionalEventListener for CQRS

The cqrs package ships a `@TransactionalEventsListener` decorator, equivalent
to Spring's `@TransactionalEventListener`:

- **BEFORE_COMMIT**: invoked before commit; an error rolls the transaction
  back
- **AFTER_COMMIT**: invoked after a successful commit (the main use case)
- **AFTER_ROLLBACK**: invoked after a rollback
- **AFTER_COMPLETION**: invoked on any completion

This solves the classic problem of "event published, but the transaction was
rolled back". With AFTER_COMMIT this cannot happen — the listener only runs
once the commit has succeeded.

### 6. AggregateRoot integration

For DDD/CQRS projects using `AggregateRoot` from `@nestjs/cqrs`:

```typescript
const order = this.publisher.mergeObjectContext(Order.place(...));
await this.orders.save(order);
order.commit();
// events will fire in AFTER_COMMIT listeners, not immediately
```

`commit()` is retargeted by swapping `EventPublisher` for our
`TransactionalEventPublisherAdapter`. Events no longer go straight to the
in-memory EventBus — they are registered on the current transaction as
hooks for the appropriate phase.

---

## Design Decisions

### DD-001: AsyncLocalStorage as the foundation

**Alternatives**:
- continuation-local-storage (cls-hooked) — legacy, deprecated
- Passing context explicitly through parameters — breaks the API surface

**Choice**: AsyncLocalStorage from Node.js core. Stable since Node 14,
performant, correct across async boundaries.

**Trade-off**: there is a small performance overhead (<5% on typical
operations), but it is real. For critical hot paths, the programmatic API
`manager.run()` can be used in place of the decorator.

### DD-002: We do not fork @nestjs/cqrs

**Alternatives**:
- Fork @nestjs/cqrs with our changes
- Our own CQRS-like package

**Choice**: work on top of the original `@nestjs/cqrs` via:
- Runtime wrapping of handlers (replacing the `execute` method on instances)
- Override of EventPublisher through DI
- Our own TransactionalEventDispatcher alongside the original EventBus

**Trade-off**: we depend on `@nestjs/cqrs` internals (they can change). But
we don't have to maintain a fork, and users get the normal upgrade path.

### DD-003: One package, one responsibility

**Alternatives**:
- A monolithic `@nestjs-transactional` package with optional parts
- Core + a single "integrations" package

**Choice**: three separate packages. Users install only what they need:
- Transactions without CQRS → core + typeorm
- CQRS without TypeORM (e.g. Prisma, once that adapter exists) →
  core + cqrs + prisma

**Trade-off**: more release overhead (multiple package versions), but a
cleaner architecture and smaller bundle size.

### DD-004: Adapter as interface, not base class

**Alternatives**:
- An abstract `TransactionAdapter` base class with shared logic
- An interface with implementation rules documented

**Choice**: pure interface. All shared logic lives in TransactionManager;
adapters are minimal ORM-specific implementations.

**Trade-off**: adapters must implement two methods (`runInTransaction`,
`runInSavepoint`). That's the minimum, and it's easy to add new adapters.

### DD-005: Multiple datasources as a first-class feature

**Alternatives**:
- A single DataSource per app (simpler API)
- Multiple DataSources through a separate package

**Choice**: multi-DataSource support from day one. Each adapter is registered
under an `instanceName` (e.g. `'primary'`, `'billing'`).

```typescript
@Transactional({ adapterInstance: 'billing' })
async generateInvoice() { ... }
```

**Trade-off**: the API is slightly more complex (the `adapterInstance`
parameter), but without this, users cannot realistically use the package in
multi-database projects.

### DD-006: Jest over Vitest

**Rationale**: Jest is the NestJS default; all documentation and examples
use it, and `@nestjs/testing` integrates natively. Vitest is faster, but
for library-level testing the difference is not critical.

### DD-007: Legacy decorators + reflect-metadata

**Context**: the entire NestJS ecosystem (core, TypeORM, @nestjs/cqrs)
runs on legacy decorators with the `reflect-metadata` polyfill. TC39
stage-3 decorators are incompatible: there are no parameter decorators
(critical for `@Inject`), different metadata rules, and a different
decorator return type.

**Alternatives**:
- TC39 stage-3 decorators (TypeScript 5.0+) — incompatible with NestJS
- Runtime DI only, no decorators — changes the entire API and loses the
  NestJS integration patterns

**Choice**: `experimentalDecorators: true`, `emitDecoratorMetadata: true`,
peer dependency `reflect-metadata ^0.1.13 || ^0.2.0`.

**Consequences**: compatibility with NestJS 10 and 11. If NestJS migrates
to stage-3 (not expected in the next 1–2 years) we will follow, but that
is a breaking change for the entire ecosystem.

### DD-008: Method wrapping via a triad of mechanisms

**See also**: `docs/adr/005-method-wrapping-strategy.md` for detailed
rationale.

**Context**: `@Transactional()` must work on controller methods, regular
`@Injectable` services, and CQRS handlers. No single NestJS mechanism
covers all cases:
- Interceptors via `APP_INTERCEPTOR` only fire at the request boundary
- Prototype wrapping inside the decorator has no access to DI (nowhere to
  get TransactionManager from)
- Runtime wrapping via `DiscoveryService` requires a post-bootstrap hook

**Choice**: the `@Transactional` decorator is metadata-only (via
`Reflect.defineMetadata`). Wrapping is performed by three coordinated
mechanisms:

1. **TransactionalInterceptor** (`APP_INTERCEPTOR`) — for controllers,
   resolvers, gateways, and message patterns (request boundary)
2. **TransactionalMethodsBootstrap** (`OnApplicationBootstrap`) — for
   regular `@Injectable` services via `DiscoveryService`
3. **CqrsHandlerWrapper** (`OnApplicationBootstrap` in the cqrs package)
   — for `@CommandHandler` / `@QueryHandler` / `@EventsHandler` with
   `TransactionalEventPublisher` integration

**Coordination**: a marker via `Reflect.defineMetadata(WRAPPED_MARKER,
true, wrapped)` where `WRAPPED_MARKER =
Symbol.for('@nestjs-transactional/wrapped')`. This double-wrap guard is
stateless and safe across tests that call `Test.createTestingModule()`
frequently.

**Fallback**: if a method is accidentally wrapped twice, propagation
REQUIRED handles it — the existing transaction is reused rather than a
second one being started.

**Trade-off**: more infrastructure code (three components instead of one).
Debugging requires familiarity with all three mechanisms. Mitigation:
a detailed ADR-005, debug-level logging at wrap time, and a clear file
layout with obvious names.

---

## Core Package (@nestjs-transactional/core)

### Public API

```typescript
// Decorators
Transactional(options?: Partial<TransactionalMetadata>): MethodDecorator & ClassDecorator
ReadOnly(options?: Partial<TransactionalMetadata>): MethodDecorator
TransactionalOn(adapterInstance: string, options?: Partial<TransactionalMetadata>): MethodDecorator

// Types
PropagationMode: enum
IsolationLevel: 'READ_UNCOMMITTED' | 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE'
TransactionOptions, ExtendedTransactionOptions: interfaces
TransactionHandle: interface (base for adapter-specific handles)
TransactionAdapter<THandle>: interface

// Runtime
TransactionManager: class
  - run<T>(options, fn): Promise<T>
  - registerAfterCommit(hook): void
  - registerAfterRollback(hook): void
  - registerBeforeCommit(hook): void

TransactionContext: class (static methods)
  - run(correlationId, fn): Promise<T>
  - getStore(): TransactionContextStore | undefined
  - getActiveTransaction(adapterInstanceName): ActiveTransaction | undefined

// Module
TransactionalModule.forRoot(options): DynamicModule
TransactionalModule.forRootAsync(options): DynamicModule

// Interceptor (usually wired via TransactionalModule; exported for manual binding)
TransactionalInterceptor: class implements NestInterceptor

// Errors
TransactionError (base)
IllegalTransactionStateError
TransactionAdapterNotFoundError
OutboxWriteError

// Observability
TransactionObserver: interface
TRANSACTION_OBSERVERS: InjectionToken

// Testing (via /testing subpath)
InMemoryTransactionAdapter: class
```

### Not Exposed (Internal)

- AdapterRegistry internals (registered through DI, but the implementation
  is internal)
- Hook execution internals

### Exported but typically wired via `TransactionalModule`

- `TransactionalInterceptor` — registered via `APP_INTERCEPTOR` by
  `TransactionalModule.forRoot` (enabled by default; opt out with
  `registerInterceptor: false`). Exported so advanced consumers can bind
  it manually on specific controllers instead of globally.

---

## TypeORM Package (@nestjs-transactional/typeorm)

### Public API

```typescript
// Adapter
TypeOrmTransactionAdapter: class implements TransactionAdapter<TypeOrmTransactionHandle>

// Helpers
getCurrentEntityManager(adapterInstance?: string, fallback?: DataSource): EntityManager
isInTransaction(adapterInstance?: string): boolean

// Types
TypeOrmTransactionHandle extends TransactionHandle
  - entityManager: EntityManager

// Module
TypeOrmTransactionalModule.forFeature(options): DynamicModule
  options: {
    instanceName?: string,
    dataSource: DataSource | (() => Promise<DataSource> | DataSource),
    isDefault?: boolean,
  }
```

### Usage Pattern

Repositories read through the helper:

```typescript
@Injectable()
export class TypeOrmOrderRepository implements OrderRepository {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async save(order: Order): Promise<void> {
    const em = getCurrentEntityManager('default', this.ds);
    await em.save(OrderOrm, OrderMapper.toOrm(order));
  }
}
```

`getCurrentEntityManager` checks AsyncLocalStorage:
- If there is an active transaction, it returns that transaction's
  EntityManager
- If not, and a fallback is provided, it uses `dataSource.manager`
- If not, and there is no fallback, it throws

---

## CQRS Package (@nestjs-transactional/cqrs)

### Public API

```typescript
// Decorators
TransactionalEventsListener<T>(eventType: Type<T>, options?: {
  phase?: TransactionPhase,           // default AFTER_COMMIT
  fallbackExecution?: boolean,        // default false
  async?: boolean,                    // default false
}): MethodDecorator

// Enums
TransactionPhase: BEFORE_COMMIT | AFTER_COMMIT | AFTER_ROLLBACK | AFTER_COMPLETION

// Services (rarely used directly by consumers)
TransactionalEventPublisher: class — EventPublisher replacement, installed via override
TransactionalEventDispatcher: class — internal routing

// Module
CqrsTransactionalModule.forRoot(options?: {
  wrapCommandHandlers?: boolean,      // default true
  wrapQueryHandlers?: boolean,        // default true
  wrapEventHandlers?: boolean,        // default true
  defaultQueryOptions?: Partial<TransactionalMetadata>,  // default { readOnly: true }
  defaultCommandOptions?: Partial<TransactionalMetadata>,
  useTransactionalEventPublisher?: boolean,  // default true
}): DynamicModule
```

### Behavior

**CommandHandler wrapping**: at application startup, all classes annotated
with `@CommandHandler()` are scanned. If the class or its `execute` method
carries `@Transactional()` metadata, `execute` is wrapped in
`transactionManager.run()`.

**QueryHandler defaults**: queries are wrapped as read-only transactions by
default (unless `defaultQueryOptions` disables that).

**EventPublisher override**: the `EventPublisher` from `@nestjs/cqrs` is
replaced with our adapter. When `AggregateRoot.commit()` calls `publishAll`,
events flow through `TransactionalEventPublisher`, which registers them on
the current transaction as hooks.

**Event dispatching**:
- Publish OUTSIDE a transaction:
  - listeners with `fallbackExecution: true` are invoked directly
  - others are ignored (with a warning in the log)
- Publish INSIDE a transaction:
  - BEFORE_COMMIT: registered in beforeCommitHooks (an error rolls back)
  - AFTER_COMMIT: registered in afterCommitHooks
  - AFTER_ROLLBACK: registered in afterRollbackHooks
  - AFTER_COMPLETION: registered in both (commit and rollback)

---

## Coding Conventions

### TypeScript

- **strict mode** is mandatory: `"strict": true` in tsconfig
- **No implicit any**: all types are explicit
- **Readonly where possible**: parameters and properties are `readonly`
  when they are not reassigned
- **No enum for string literals unless needed**: for simple string
  constants, use union types (exception: `PropagationMode` — where IDE
  auto-completion matters)
- **Never use `any`**: if you really must, use `unknown` plus type
  narrowing

### Naming

- **Classes**: PascalCase (`TransactionManager`)
- **Interfaces**: PascalCase without an `I` prefix (`TransactionAdapter`,
  not `ITransactionAdapter`)
- **Types**: PascalCase (`IsolationLevel`)
- **Enum members**: SCREAMING_SNAKE_CASE (`PropagationMode.REQUIRES_NEW`)
- **Functions/methods**: camelCase (`runInTransaction`)
- **Constants**: SCREAMING_SNAKE_CASE (`ADAPTER_REGISTRY`)
- **Private fields**: `_` prefix not required, but allowed for internal
  state
- **DI tokens**: SCREAMING_SNAKE_CASE with `Symbol` (`ADAPTER_REGISTRY`,
  `TRANSACTION_OBSERVERS`)

### File Structure

One file = one primary public entity (class / interface / function).
Helper types live in the same file if only used there, otherwise in a
separate file.

File names follow NestJS-style dot notation: `<name>.<artifact-suffix>.ts`
where the suffix names the kind of artifact (`service`, `controller`,
`module`, `interceptor`, `context`, `manager`, `registry`, `adapter`,
`publisher`, `dispatcher`, `wrapper`, `bootstrap`, ...). The `<name>` part
is kebab-case if multi-word (e.g. `cqrs-handler.wrapper.ts`). Spec files
mirror the source file name with a `.spec.ts` suffix; integration specs
use `.integration.spec.ts`.

```
src/
├── manager/
│   ├── transaction.manager.ts         # class TransactionManager
│   ├── transaction.manager.spec.ts    # tests (colocated)
│   ├── adapter.registry.ts            # class AdapterRegistry
│   └── adapter.registry.spec.ts
```

Pure type / interface files are an exception: no suffix, kebab-case
allowed when the filename describes the type it exports (e.g.
`packages/core/src/types/transaction-handle.ts`, `isolation.ts`,
`propagation.ts`).

### Tests

- **Colocated**: tests live next to code (`.spec.ts` beside `.ts`)
- **Jest style**: `describe` / `it` / `expect`
- **Naming**: `describe('TransactionManager')` with
  `it('should create a new tx if none is active')` inside
- **Setup / teardown**: prefer factory functions over shared state
- **Mocking**: `jest.fn()`, `jest.mock()` — but sparingly. Prefer real
  implementations with controlled inputs
- **Integration tests**: separate config `jest.integration.config.js`,
  suffix `.integration.spec.ts`

### Errors

- **All errors inherit from `TransactionError`** (the package's base)
- **Every error has a `readonly code: string`** for structured logging
- **Messages**: explicit, actionable, and carry context

```typescript
export class TransactionAdapterNotFoundError extends TransactionError {
  readonly code = 'TRANSACTION_ADAPTER_NOT_FOUND';

  constructor(adapterName: string, instanceName: string) {
    super(
      `Transaction adapter not found: ${adapterName}:${instanceName}. ` +
      `Did you register it via TypeOrmTransactionalModule.forFeature()?`
    );
  }
}
```

### Documentation

- **JSDoc on all public APIs** (classes, methods, interfaces)
- **@param, @returns, @throws** where applicable
- **@example for non-trivial APIs**
- **Internal entities** — JSDoc optional, encouraged for complex logic
- **Language**: all committed text (CLAUDE.md, ADRs, READMEs, JSDoc,
  inline comments, commit messages) is English

---

## What NOT to do

### In the core package

- **DO NOT import TypeORM, Prisma, or any concrete ORM**
- **DO NOT import @nestjs/cqrs**
- **DO NOT use global state** (everything through DI or AsyncLocalStorage)
- **DO NOT make breaking API changes between minor versions**

### In the typeorm package

- **DO NOT import @nestjs/cqrs**
- **DO NOT implement business logic** — only transactional mechanics
- **DO NOT hardcode database or instance names** — everything is
  configurable

### In the cqrs package

- **DO NOT fork @nestjs/cqrs** — only wrapping and override through DI
- **DO NOT touch commandBus / queryBus** beyond handlers (sagas use the
  public API)
- **DO NOT break default @nestjs/cqrs behavior** for handlers without
  `@Transactional()` — they must work as before

### Everywhere

- **DO NOT use console.log/warn/error in production paths** — use the
  NestJS Logger
- **DO NOT throw generic Error** — only specific classes inheriting from
  TransactionError
- **DO NOT catch without rethrow** without an explicit reason (swallowing
  errors hides bugs)
- **DO NOT use `any`** without `@ts-expect-error` and a comment
- **DO NOT change public interfaces** without a changeset
- **DO NOT wrap a method directly inside a decorator** — decorators only
  write metadata; wrapping is performed by the bootstrap / interceptor
  mechanisms that have DI access (see ADR-005)
- **DO NOT use TC39 stage-3 decorator syntax** — the whole ecosystem is
  on legacy + reflect-metadata (see DD-007)

---

## Testing Strategy

### Core package

- **Unit tests**: TransactionContext, TransactionManager, AdapterRegistry,
  decorators, interceptor — isolated and fast
- **InMemoryTransactionAdapter** is used for tests that do not need a real
  database
- **Coverage target**: at least 90% lines, 85% branches on public API

### TypeORM package

- **Unit tests** with SQLite in-memory for fast checks
- **Integration tests** with testcontainers (real Postgres) for:
  - Savepoint behavior
  - Isolation levels
  - Multi-datasource scenarios
  - Connection pool behavior
- **Coverage target**: 85% lines on units; integration tests cover
  end-to-end scenarios

### CQRS package

- **Unit tests** for decorators, scanner, wrapper — with a mocked
  TransactionManager
- **Integration tests** with a full NestJS testing module:
  - Real CqrsModule
  - InMemoryTransactionAdapter (or TypeORM with SQLite)
  - Full flow: command → handler → aggregate → events → listeners
- **E2E tests** for cross-package interaction (cqrs + typeorm + core)
- **Coverage target**: 85% on handler logic

### Test utilities

The core package exports utilities via the `/testing` subpath:

```typescript
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
```

The cqrs package may expose:

```typescript
import { TransactionalTestingModule } from '@nestjs-transactional/cqrs/testing';
```

---

## Development Workflow

### Setup

```bash
pnpm install
pnpm -r build
pnpm -r test
```

### Working on a package

```bash
# Watch mode for the active package
pnpm --filter @nestjs-transactional/core test:watch

# Build a single package
pnpm --filter @nestjs-transactional/typeorm build

# Integration tests (requires Docker for testcontainers)
pnpm --filter @nestjs-transactional/typeorm test:integration
```

### Adding a changeset

For any user-facing change:

```bash
pnpm changeset
# Pick the affected package(s), the bump (patch/minor/major), and a message
```

### Commit message style

Conventional Commits:
- `feat(core): add NESTED propagation support`
- `fix(typeorm): correctly release savepoint on success`
- `docs: update getting-started guide`
- `refactor(cqrs): extract event dispatcher scheduling logic`
- `test(core): add tests for REQUIRES_NEW edge cases`

Breaking changes: `feat(core)!: ...` or `BREAKING CHANGE:` in the body.

---

## Implementation Roadmap

### Phase 0: Monorepo setup
- pnpm workspaces, TypeScript project references
- Jest configuration
- ESLint, Prettier
- Changesets
- CI skeleton (GitHub Actions)

### Phase 1: @nestjs-transactional/core
- Types and interfaces
- TransactionContext (AsyncLocalStorage)
- AdapterRegistry
- InMemoryTransactionAdapter (for testing)
- TransactionManager (with all propagation modes)
- @Transactional decorator (metadata only — see ADR-005)
- TransactionalInterceptor (for the request boundary)
- **ADR-005 document** (before implementation of the bootstrap)
- **TransactionalMethodsBootstrap** (service-level wrapping via
  DiscoveryService)
- TransactionalModule (forRoot / forRootAsync)
- Observability hooks (before/after commit/rollback)

### Phase 2: @nestjs-transactional/typeorm
- TypeOrmTransactionAdapter
- getCurrentEntityManager, isInTransaction helpers
- TypeOrmTransactionalModule
- Multi-datasource support
- Savepoints for NESTED propagation

### Phase 3: @nestjs-transactional/cqrs
- TransactionPhase enum, metadata types
- @TransactionalEventsListener decorator
- TransactionalEventDispatcher (with phase routing)
- TransactionalListenerScanner (auto-registration)
- CqrsHandlerWrapper (handler decoration at bootstrap)
- CqrsTransactionalBootstrap (OnApplicationBootstrap)
- TransactionalEventPublisher + Adapter (override of the @nestjs/cqrs
  EventPublisher)
- AggregateRoot integration (mergeObjectContext, mergeClassContext)
- CqrsTransactionalModule

### Phase 4: CI/CD and publishing
- Full GitHub Actions workflow
- Release automation with changesets
- NPM publishing setup
- Documentation generation

### Future phases (not committed, tentative)
- **@nestjs-transactional/outbox**: Transactional Outbox pattern helpers
- **@nestjs-transactional/prisma**: Prisma adapter
- **@nestjs-transactional/drizzle**: Drizzle adapter
- **OpenTelemetry integration**: built-in tracing
- **ESM dual packaging**: ESM export support

---

## Quality Gates

Before merging into main:

- [ ] All tests green (`pnpm -r test`)
- [ ] Integration tests green (`pnpm -r test:integration`)
- [ ] Build with no warnings (`pnpm -r build`)
- [ ] Lint clean (`pnpm -r lint`)
- [ ] Coverage has not dropped below baseline
- [ ] Changeset added (for user-facing changes)
- [ ] README / docs updated when the public API changed
- [ ] ADR added for significant architectural decisions

---

## Spring Framework Reference

Since we model the API on Spring, useful reference points:

- **Spring @Transactional**: https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html
- **Propagation modes**: https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html
- **@TransactionalEventListener**: https://docs.spring.io/spring-framework/reference/core/aop/introduction-defn.html (implicit)
- **Spring Modulith Event Publication Registry**: https://docs.spring.io/spring-modulith/reference/events.html

We do not pursue 100% feature parity — we take what makes sense in the
Node.js ecosystem and covers real use cases of NestJS applications.

---

## Session Onboarding for Claude Code

When starting a new session:

1. Read this CLAUDE.md in full
2. Look at the repository structure (`packages/`, `docs/`)
3. Check the current state: what is already implemented, what phase we
   are in
4. Confirm your understanding with the user before starting work
5. If anything is unclear — ask before writing code

While working:

1. **Tests-first**: tests first (describing the behavior), then
   implementation
2. **Small iterations**: run tests and linter after each meaningful step
3. **Check constraints**: you are not crossing dependency boundaries
   (core knows nothing about typeorm, etc.)
4. **Update docs**: if the public API changed, update the README and JSDoc
5. **Ask when uncertain**: better to ask than to guess
6. **Language**: all committed text in the repo is English. Chat with
   the user is Russian unless they switch.

If the task requires an architectural decision not described in
CLAUDE.md — **stop and discuss** with the user. It may become an ADR.

---

## Current Status

**Last updated**: 2026-04-24.
**Session handoff**: `docs/sessions/2026-04-24-handoff.md` — read
first when resuming.

**Phase**: Phases 1, 2, 3 complete. Phase 4 substantially done —
examples, release workflow, publishing hygiene, and npm provenance
all in place; the only remaining blockers for tagging 0.1.0 are
running the TypeORM integration tests against Docker and wiring the
`NPM_TOKEN` GitHub secret.

**Test suite**: 175 unit tests green (114 core + 18 typeorm + 43 cqrs).
TypeORM integration specs (10 tests in 2 files) compile and are
discovered by the integration Jest config but **have not been run yet**
in any session — they need Docker for testcontainers-node.

**Publishable tarballs** (`npm pack --dry-run`): core 34.6 KB / 59
entries, typeorm 7.8 KB / 17 entries, cqrs 21.6 KB / 32 entries — zero
spec files in any tarball after the `tsconfig.build.json` split.

### Phase 0 — Monorepo setup — DONE
- pnpm workspaces, TypeScript project references (composite: true)
- Jest + ts-jest + `setupFiles: ['reflect-metadata']`
- ESLint 8 (legacy `.eslintrc.js`) + Prettier 3
- Changesets initialised
- CI workflow at `.github/workflows/ci.yml` — Node 20 + 22 matrix: lint, build, test, type-check

### Phase 1 — `@nestjs-transactional/core` — DONE
- Types: `PropagationMode` (all 7 Spring modes), `IsolationLevel`,
  `TransactionOptions`, `ExtendedTransactionOptions`, `TransactionHandle`,
  `TransactionAdapter<THandle>`, `DomainEvent`, errors (`TransactionError`
  base + `IllegalTransactionStateError`, `TransactionAdapterNotFoundError`,
  `OutboxWriteError`)
- `TransactionContext` — `AsyncLocalStorage`-backed store with
  `ActiveTransaction` entries
- `AdapterRegistry` + `ADAPTER_REGISTRY` DI token
- `InMemoryTransactionAdapter` (exported via `/testing` subpath)
- `TransactionManager` — all seven propagation modes (REQUIRED,
  REQUIRES_NEW, NESTED savepoint, SUPPORTS, NOT_SUPPORTED, NEVER,
  MANDATORY), rollback rules (`rollbackFor` / `noRollbackFor`),
  lifecycle hooks (before-commit / after-commit / after-rollback),
  observers
- `@Transactional()` / `@ReadOnly()` / `@TransactionalOn()` decorators
  (metadata-only via `reflect-metadata`)
- `TransactionalInterceptor` — `APP_INTERCEPTOR` for the request boundary
- **`TransactionalMethodsBootstrap`** — `OnApplicationBootstrap` service
  that wraps every `@Transactional()` method on plain `@Injectable()`
  providers with `TransactionManager.run(...)`. Skips CQRS handlers (by
  metadata) and already-wrapped methods (by `WRAPPED_MARKER`).
  Registered by `TransactionalModule.forRoot` unless the caller sets
  `registerMethodsBootstrap: false`.
- `TransactionalModule.forRoot` + `forRootAsync`
- `TransactionObserver` + `TRANSACTION_OBSERVERS` for monitoring
- `docs/architecture/core-design.md` documents the three extension points

### Phase 2 — `@nestjs-transactional/typeorm` — DONE
- `TypeOrmTransactionAdapter` using `DataSource.transaction(...)` and
  raw `SAVEPOINT` SQL for nested transactions
- `TypeOrmTransactionHandle` (extends core handle with `entityManager`)
- `getCurrentEntityManager(adapterInstance?, fallback?)` +
  `isInTransaction(adapterInstance?)` helpers
- `TypeOrmTransactionalModule.forFeature` — inline `useFactory` that
  registers the adapter with the shared `AdapterRegistry`
- Integration scaffolding: `test/setup-testcontainers.ts` with
  `startPostgresContainer` / `stopPostgresContainer` /
  `createAdditionalDatabase` helpers, plus `jest.integration.config.js`

**Limitations documented in `docs/sessions/phase-2-complete.md` §4:**
`readOnly` and `timeout` options accepted but not yet mapped to
per-dialect SQL; `forFeature` does not accept an `InjectionToken` for
the DataSource yet.

### Phase 3 — `@nestjs-transactional/cqrs` — DONE
- `TransactionPhase` enum + `TransactionalEventsListenerMetadata` types
- `@TransactionalEventsListener(EventType, { phase, fallbackExecution, async })`
  decorator (metadata-only)
- `TransactionalEventDispatcher` — routes events to listeners via
  `manager.registerBeforeCommit` / `registerAfterCommit` /
  `registerAfterRollback`; fallback execution outside a transaction
  goes via `queueMicrotask` (or warn-log + skip); `async: true` is
  fire-and-forget regardless of phase
- `TransactionalListenerScanner` — `OnModuleInit` that walks every
  provider via `DiscoveryService` + `MetadataScanner` and auto-registers
  decorated methods with the dispatcher
- `CqrsHandlerWrapper` + `CqrsTransactionalBootstrap` — wrap
  `@CommandHandler` / `@QueryHandler` / `@EventsHandler` instances at
  application bootstrap; classify by metadata key, honour method-level
  `@Transactional` > class-level > kind defaults (`defaultQueryOptions`,
  `defaultCommandOptions`)
- `TransactionalEventPublisher` + `TransactionalEventPublisherAdapter`
  — drop-in replacement for `@nestjs/cqrs`'s `EventPublisher`;
  `mergeObjectContext` / `mergeClassContext` route aggregate events
  through the dispatcher so `AggregateRoot.commit()` attaches phase
  hooks instead of publishing immediately
- `CqrsTransactionalModule.forRoot({ wrapCommandHandlers, wrapQueryHandlers,
  wrapEventHandlers, defaultQueryOptions, defaultCommandOptions,
  useTransactionalEventPublisher })` — single entry point

**Limitations documented in `packages/cqrs/README.md`:**
- Only works with singleton handlers (request-scoped handlers are
  resolved per-request by `@nestjs/cqrs` via `ModuleRef.resolve`,
  producing a fresh instance our bootstrap wrap has not mutated).
- Direct `eventBus.publish(...)` calls (outside an aggregate) bypass
  the transactional dispatcher. Only `AggregateRoot.commit()`-emitted
  events via `mergeObjectContext` / `mergeClassContext` get phase-aware
  semantics.
- `@nestjs/cqrs` handler-metadata constants (`__commandHandler__` etc.)
  are re-declared as string literals because `@nestjs/cqrs` does not
  re-export them. See DD-002 — the coupling is accepted.

### Phase 4 — CI/CD, publishing, examples — SUBSTANTIALLY DONE
- Runnable examples under `examples/*` (added to `pnpm-workspace.yaml`):
  - `examples/basic-usage/` — `@Transactional` on a plain service
  - `examples/multi-datasource/` — `@Transactional` + `@TransactionalOn`
    against two `TypeOrmTransactionalModule.forFeature` registrations
  - `examples/cqrs-full-stack/` — full CQRS flow with aggregate,
    command, query, and `AFTER_COMMIT` / `AFTER_ROLLBACK` listeners
  - Each has `pnpm start` (`tsc && node dist/main.js`) and a README.
- GitHub Actions release workflow at `.github/workflows/release.yml`
  (push-to-main, `id-token: write`, `changesets/action@v1` for
  Version PR + publish).
- Root `README.md` + `CONTRIBUTING.md` with setup, tests, changeset
  workflow, commit style, dependency boundaries, release + provenance.
- Changelog generator upgraded to `@changesets/changelog-github` for
  PR-linked entries.
- `dist/**/*.spec.*` leakage fixed via per-package `tsconfig.build.json`
  (emit, excludes specs) vs `tsconfig.json` (noEmit, for jest + IDE +
  type-check script). Narrow `files` array in each `package.json`
  with `!dist/**/*.spec.*` negation as a second-line guard.
- npm provenance wired via `publishConfig: { access: "public",
  provenance: true }` in each publishable `package.json` (not via a
  `changeset publish --provenance` flag — that flag does not exist in
  `@changesets/cli@2.31`).

**Still open in Phase 4 (blockers for tagging 0.1.0):**
- Run TypeORM integration tests on a Docker-enabled machine
  (`pnpm --filter @nestjs-transactional/typeorm test:integration`).
  10 tests discovered, 0 executed to date.
- Add `NPM_TOKEN` as a GitHub repo secret (granular publish token
  scoped to `@nestjs-transactional` — classic tokens are
  incompatible with OIDC provenance).
- Create the first changeset bumping all three packages to 0.1.0
  with an initial-release summary.

**Deferred to post-0.1.0:**
- `moduleResolution: "bundler"` migration to unlock
  `@nestjs-transactional/core/testing` subpath from sibling packages
  (currently they inline a fake adapter).
- Coverage pipeline (Codecov / Coveralls) + badge.
- Unify cqrs test layout (iteration 3.1's decorator spec is in
  `test/unit/`, everything else is colocated in `src/**`).
- Bridge `eventBus.publish(...)` → transactional dispatcher for
  non-aggregate event emissions.
- `@nestjs/testing` in cqrs `devDependencies` (currently resolves via
  hoisted root).

### Conventions finalised during implementation (not in the Design Decisions section above)

1. **Composite context key `${adapterName}:${instanceName}`.**
   `TransactionManager` writes every active transaction under a
   composite key, not just `instanceName`. Prevents collision between
   e.g. `typeorm:default` and `in-memory:default` when both are
   registered. Adapter-side helpers must compose their lookup key the
   same way — see `typeOrmContextKey` in
   `packages/typeorm/src/helpers/get-entity-manager.ts`.

2. **`TransactionalInterceptor` is part of the public API.** CLAUDE.md
   previously listed it under "Not Exposed". See § "Exported but
   typically wired via `TransactionalModule`" above.

3. **`TransactionalModule.forRoot({ isGlobal: true })` is required when
   pairing with `TypeOrmTransactionalModule`.** Otherwise
   `AdapterRegistry` is not visible in the typeorm module's provider
   scope and DI fails at init.

4. **Test file layout is inconsistent across packages.** Core colocates
   `.spec.ts` next to source. TypeORM uses `test/unit/`,
   `test/integration/`, `test/shared/`. CQRS mostly colocates in `src/`
   with one exception (`test/unit/transactional-events-listener.decorator.spec.ts`
   — historical, can be moved to match). Pick one per package and stay
   consistent within the package.

5. **Session handoff notes live under `docs/sessions/`.** Read
   `docs/sessions/phase-2-complete.md` first when resuming after a
   long gap — it lists current state, open issues, and the next-session
   prompt sequence in more detail than this status block.

6. **Do NOT import `CqrsModule` directly alongside `CqrsTransactionalModule.forRoot()`.**
   The transactional module imports `CqrsModule` internally and overrides
   the `EventPublisher` DI token. A duplicate `CqrsModule` import in the
   consumer shadows the override — handlers inject the original
   `EventPublisher` from `CqrsModule` and aggregate events bypass the
   dispatcher. Documented in `packages/cqrs/README.md`.

7. **`CQRS_TRANSACTIONAL_OPTIONS` + `CQRS_HANDLER_WRAPPER_OPTIONS` are
   separate injection tokens.** The module-level token is a string
   (`'CQRS_TRANSACTIONAL_OPTIONS'`); the handler-wrapper-level one is a
   `Symbol`. `CqrsTransactionalModule.forRoot` builds the wrapper via
   `useFactory`, passing the resolved options directly — it does not
   wire the Symbol token. If you instantiate `CqrsHandlerWrapper`
   outside the module, provide the Symbol token yourself.

8. **`WRAPPED_MARKER` is shared via `Symbol.for('@nestjs-transactional/wrapped')`.**
   The core package does not re-export the symbol from its public
   barrel (internal per JSDoc), but re-deriving it in any package gives
   the same identity — `Symbol.for` is process-global. All three
   wrapping mechanisms (interceptor, methods-bootstrap, cqrs handler
   wrapper) check this marker before wrapping to prevent double-wrap.
