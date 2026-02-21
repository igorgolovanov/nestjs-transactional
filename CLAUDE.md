# @nestjs-transactional monorepo

## Overview

This repository aims to deliver Spring Modulith-equivalent transaction and
event-delivery infrastructure for NestJS applications, split across a
growing set of npm packages organised by concern.

### Current (published / in-tree)

- **@nestjs-transactional/core** — base infrastructure: AsyncLocalStorage context,
  TransactionManager with propagation modes, `@Transactional()` decorator,
  adapter port interfaces. No dependency on any concrete ORM.

- **@nestjs-transactional/typeorm** — TypeORM adapter, helper for retrieving the
  active EntityManager from the current async context, integration with
  `@nestjs/typeorm`.

- **@nestjs-transactional/cqrs** — integration with `@nestjs/cqrs`: runtime
  wrappers for CommandHandler/QueryHandler/EventHandler, class-level
  `@TransactionalEventsHandler` decorator with Spring-like phases
  (BEFORE_COMMIT, AFTER_COMMIT, AFTER_ROLLBACK, AFTER_COMPLETION),
  `HybridEventPublisher` + `@ApplicationModuleHandler` that bridge to
  the outbox when wired, and an EventPublisher override that integrates
  with AggregateRoot.

- **@nestjs-transactional/outbox-core** *(alpha)* — persistent Event
  Publication Registry: lifecycle states, repository SPI, async worker,
  staleness monitor, startup recovery, operator APIs
  (Failed/Incomplete/Completed), testing utilities
  (`PublishedEvents`, `AssertablePublishedEvents`). ORM-agnostic.

- **@nestjs-transactional/outbox-typeorm** *(alpha)* — TypeORM
  persistence backend for the outbox: `event_publication` + archive
  entities, `TypeOrmEventPublicationRepository` with
  `FOR UPDATE SKIP LOCKED`, shipped migration, development-time
  `SchemaInitializer`, and `OutboxTypeOrmModule` for wiring.

### Future (not scheduled)

- **@nestjs-transactional/outbox-kafka** — event externalization to Kafka
- **@nestjs-transactional/outbox-rabbitmq** — RabbitMQ externalization
- **@nestjs-transactional/outbox-prisma** — Prisma persistence backend
- **@nestjs-transactional/outbox-mongodb** — MongoDB persistence backend
- **@nestjs-transactional/testing** — integration testing utilities
  cross-cutting over core / typeorm / cqrs / outbox

## Mission Statement

Give NestJS applications transaction management on par with Spring Framework:
a declarative `@Transactional`, the full set of propagation modes, support for
multiple DataSources in the same app, and a tight integration with
event-driven paradigms through CQRS with phase-aware listeners.

---

## Spring Modulith Parity Goal

This monorepo aims to provide Spring Modulith-equivalent functionality
for NestJS applications, not just Spring Framework core.

### Scope coverage

**Spring Framework core features (covered in existing packages):**
- `@Transactional` with propagation modes (core)
- `@TransactionalEventListener` with transaction phases (cqrs)
- Multi-DataSource support (typeorm)
- AsyncLocalStorage for transaction context (core)

**Spring Modulith features (partially covered, expansion planned):**
- Event Publication Registry with persistent log — outbox-core (Phase 5)
- `@ApplicationModuleHandler` shortcut — cqrs integration (Phase 7)
- Failed / Incomplete / Completed publications API — outbox-core (Phase 5)
- Staleness monitor — outbox-core (Phase 5)
- Republish on restart — outbox-core (Phase 5)
- Completion modes (UPDATE / DELETE / ARCHIVE) — outbox-core (Phase 5)
- `PublishedEvents` test utility — outbox-core `/testing` (Phase 8)
- Event externalization to brokers — future (not scheduled)

**Explicitly out of scope:**
- Module boundary verification (Spring Modulith's `ApplicationModuleVerification`)
  — use `@nx/enforce-module-boundaries` or similar for this
- Documentation generation (Spring Modulith's `Documenter`) — use TypeDoc

### Positioning note

This is a deliberate scope commitment made after comparing with Spring
Modulith 2.0.5 documentation
(https://docs.spring.io/spring-modulith/reference/events.html).
Prior positioning of "Spring Framework equivalent" was insufficient —
production systems need the delivery guarantees Spring Modulith provides.

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
│   ├── cqrs/                          # @nestjs-transactional/cqrs
│   │   ├── src/
│   │   │   ├── decorators/            # @TransactionalEventsHandler, @ApplicationModuleHandler
│   │   │   ├── interfaces/            # ITransactionalEventsHandler, IApplicationModuleHandler
│   │   │   ├── types/                 # TransactionPhase
│   │   │   ├── event-dispatcher/      # TransactionalEventDispatcher
│   │   │   ├── event-publisher/       # TransactionalEventPublisher + HybridEventPublisher
│   │   │   ├── handlers/              # CqrsHandlerWrapper, listener scanner, application module scanner
│   │   │   ├── module/                # CqrsTransactionalModule
│   │   │   └── index.ts
│   │   └── ...
│   │
│   └── outbox-core/                   # @nestjs-transactional/outbox-core (alpha)
│       ├── src/
│       │   ├── types/                 # EventPublication, lifecycle states
│       │   ├── repository/            # EventPublicationRepository SPI
│       │   ├── registry/              # EventPublicationRegistry, listeners
│       │   ├── dispatcher/            # EventPublicationProcessor (async worker)
│       │   ├── recovery/              # StartupRecoveryService, StalenessMonitor
│       │   ├── module/                # OutboxModule (forRoot/forRootAsync)
│       │   ├── testing/               # InMemoryEventPublicationRepository (/testing)
│       │   └── index.ts
│       ├── test/                      # unit + integration
│       ├── package.json
│       ├── tsconfig.json              # noEmit for jest/IDE/type-check
│       ├── tsconfig.build.json        # emit, excludes specs
│       └── README.md
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
- **ADR-006**: Outbox pattern rationale — `docs/adr/006-outbox-pattern.md`
- **ADR-007**: Outbox architecture (core + typeorm split) — `docs/adr/007-outbox-architecture.md`
- **ADR-014**: Class-level handler API redesign — `docs/adr/014-handler-api-redesign.md`

Planned (not yet written):

- **ADR-008**: Event serialization strategy — `docs/adr/008-event-serialization.md`
- **ADR-009**: Listener ID stability — `docs/adr/009-listener-id-stability.md`
- **ADR-010**: Hybrid event publishing — `docs/adr/010-hybrid-event-publishing.md` *(the design was absorbed into ADR-014 — see Supersedes note there)*

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

The cqrs package ships a class-level `@TransactionalEventsHandler`
decorator, equivalent to Spring's `@TransactionalEventListener` and
modelled on `@nestjs/cqrs`'s `@EventsHandler` ergonomics:

- **BEFORE_COMMIT**: invoked before commit; an error rolls the transaction
  back
- **AFTER_COMMIT**: invoked after a successful commit (the main use case)
- **AFTER_ROLLBACK**: invoked after a rollback
- **AFTER_COMPLETION**: invoked on any completion

This solves the classic problem of "event published, but the transaction was
rolled back". With AFTER_COMMIT this cannot happen — the listener only runs
once the commit has succeeded.

Handler classes implement `ITransactionalEventsHandler<T>` and expose
a single `handle(event)` method. See ADR-014 for the rationale behind
the class-level shape.

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

### DD-009: Implement full Event Publication Registry (Spring Modulith parity)

**Context**: Scope reassessment after detailed comparison with Spring
Modulith 2.0.5. Our existing `@TransactionalEventsHandler` provides
phase-based dispatching (like Spring Framework core) but lacks the
persistent event log, retry, recovery, and delivery guarantees that
Spring Modulith provides for production systems.

**Alternatives considered**:
- Keep current scope (Spring Framework only), mention gap in documentation.
  Rejected: insufficient for production event-driven architectures.
- Recommend an external outbox library. Rejected: fragments the ecosystem,
  each library has different semantics from @nestjs-transactional packages.
- Implement as a single pattern inside the cqrs package. Rejected: couples
  persistence concerns to CQRS, prevents use of outbox without CQRS.

**Decision**: Implement full Event Publication Registry equivalent as
separate `outbox-core` + `outbox-typeorm` packages. Integration with cqrs
via `HybridEventPublisher` and the `@ApplicationModuleHandler` decorator.

**Consequences**:
- Significant scope expansion (~3 weeks of work).
- Production-ready delivery guarantees.
- Clear migration path from in-memory `@TransactionalEventsHandler` to
  persistent `@OutboxEventsHandler`.
- Larger surface area to maintain.

### DD-010: Split outbox into core + persistence packages

**Context**: Need to support multiple persistence backends (TypeORM now,
Prisma / MikroORM / MongoDB in future).

**Alternatives considered**:
- Single `@nestjs-transactional/outbox` package with TypeORM baked in.
  Rejected: forces users to adopt TypeORM.
- `@nestjs-transactional/outbox-{backend}` monolithic packages (one per
  backend). Rejected: duplicates core logic.

**Decision**: `outbox-core` with an `EventPublicationRepository` SPI plus
separate `outbox-{backend}` packages implementing the SPI. Follows the
existing pattern (core + typeorm).

**Consequences**: Clean separation, easy to add backends. Users must
install two packages, slightly more setup.

### DD-011: Hybrid event publishing (in-memory + persistent coexistence)

**Context**: The cqrs package currently publishes events via the in-memory
`TransactionalEventDispatcher`. Events also need to be routed to the
outbox for persistence when the outbox is available, without breaking
existing behavior.

**Alternatives considered**:
- Replace the in-memory dispatcher entirely with the outbox. Rejected:
  breaking change; the in-memory path has valid use cases (cache
  invalidation, metrics).
- Make users choose per listener. Rejected: usability nightmare.

**Decision**: `HybridEventPublisher` delegates to both paths —
`TransactionalEventDispatcher` (for `@TransactionalEventsHandler`
classes) and, when the `OUTBOX_PUBLICATION_SCHEDULER` token is bound,
`OutboxEventPublisher.scheduleForPublication` (for durable delivery).
`@ApplicationModuleHandler` is routed by a separate smart scanner
(see DD-013 and ADR-014) — the old "two metadata keys + skip logic"
approach from the original design has been removed.

**Consequences**: Seamless coexistence. Developers must understand
which decorator provides which guarantees — see "Delivery guarantees
at a glance" in `packages/cqrs/README.md`.

### DD-012: @ApplicationModuleHandler as smart default

**Context**: Spring Modulith's `@ApplicationModuleListener` is the
recommended default for cross-module integration. It combines
AFTER_COMMIT, async execution, a new transaction, and persistence. Users
should not need to manually compose 3–4 decorators for the common case.

**Alternatives considered**:
- Only provide `@OutboxEventsHandler`, let users compose with
  `@Transactional` when needed. Rejected: does not match Spring Modulith
  DX.
- Make it a composite decorator that works without the outbox. Done
  partially (see Decision below).

**Decision**: `@ApplicationModuleHandler` is a standalone class-level
decorator in the cqrs package. A dedicated
`ApplicationModuleHandlerScanner` decides the delivery path at
bootstrap by inspecting the `OUTBOX_LISTENER_REGISTRAR` DI token: when
bound, registers with the outbox registry (durable,
at-least-once, retried). When unbound, registers with
`TransactionalEventDispatcher` as `AFTER_COMMIT` + `async: true`,
wrapped in a fresh transaction. Behavior in both modes is documented
explicitly.

**Consequences**: Matches Spring Modulith DX. Behavior differs based on
config — must be clearly documented to avoid surprises.

### DD-013: Class-level handler API aligned with `@nestjs/cqrs`

**Context**: The original listener decorators were method-level —
annotate any method with `@TransactionalEventsListener(EventType)` and
it becomes a handler. That diverged from `@nestjs/cqrs`'s class-level
`@EventsHandler` / `@CommandHandler` / `@QueryHandler` convention, tied
listener ids to method names (breaking on rename), and left the handler
method signature unconstrained at the type level.

**Alternatives considered**:
- Extend method-level decorators with `Type[]` support for multi-event
  handlers. Rejected: still asymmetric with `@nestjs/cqrs`.
- Dual API (class-level + method-level). Rejected: two ways to do the
  same thing doubles maintenance and confuses users.
- Keep method-level with deprecation warnings. Rejected: pre-release,
  no users, no cost to a clean break.

**Decision**: Class-level only —
`@TransactionalEventsHandler(Event1, Event2, ...)`,
`@OutboxEventsHandler(Event1, Event2, ...)`,
`@ApplicationModuleHandler(Event1, Event2, ...)`. Each decorator also
accepts a long-form options object. Handler classes implement
`ITransactionalEventsHandler<T>` / `IOutboxEventsHandler<T>` /
`IApplicationModuleHandler<T>` and expose a single `handle(event)`
method. Listener ids are composed as `${baseId}#${EventName}` (baseId
defaults to the class name, can be overridden via `options.id`) — a
method rename inside a handler class no longer invalidates stored
publications.

**Consequences**: Mental-model symmetry with `@nestjs/cqrs`. Enforced
single-responsibility per handler class (a class handles one
cross-module integration concern). Breaking change vs. any pre-release
snapshot; migration is mechanical but required before upgrading past
this point. See ADR-014 for the full design rationale.

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
// Handler decorators (class-level only — see ADR-014)
TransactionalEventsHandler(...events: Type[]): ClassDecorator
TransactionalEventsHandler(options: {
  events: Type[],
  phase?: TransactionPhase,           // default AFTER_COMMIT
  async?: boolean,                    // default false
  fallbackExecution?: boolean,        // default false
}): ClassDecorator

ApplicationModuleHandler(...events: Type[]): ClassDecorator
ApplicationModuleHandler(options: {
  events: Type[],
  id?: string,                        // stable listener id base
}): ClassDecorator

// Interfaces (implement these on your handler class for type safety)
interface ITransactionalEventsHandler<T> { handle(event: T): Promise<void> | void; }
interface IApplicationModuleHandler<T> { handle(event: T): Promise<void> | void; }

// Enums
TransactionPhase: BEFORE_COMMIT | AFTER_COMMIT | AFTER_ROLLBACK | AFTER_COMPLETION

// Structural port for outbox-backed delivery of @ApplicationModuleHandler
OUTBOX_LISTENER_REGISTRAR: symbol (DI token)
interface OutboxListenerRegistrar {
  register(listener: { id: string; eventType: string; invoke: (event: unknown) => Promise<void> }): void;
}

// Structural port for outbox-backed aggregate event routing (HybridEventPublisher)
OUTBOX_PUBLICATION_SCHEDULER: symbol (DI token)
interface OutboxPublicationScheduler { scheduleForPublication(event: unknown): void; }

// Services (rarely used directly by consumers)
TransactionalEventPublisher: class — EventPublisher replacement
HybridEventPublisher: class — installed by default, routes to dispatcher + optional outbox
TransactionalEventDispatcher: class — internal event routing

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
replaced with `TransactionalEventPublisherAdapter` backed by
`HybridEventPublisher`. When `AggregateRoot.commit()` calls `publishAll`,
events flow through the hybrid publisher which routes them to (1) the
in-memory `TransactionalEventDispatcher` and (2) when the
`OUTBOX_PUBLICATION_SCHEDULER` token is bound, also to
`OutboxEventPublisher.scheduleForPublication`.

**Scanner wiring**:
- `TransactionalListenerScanner` walks providers for classes with
  `@TransactionalEventsHandler` metadata, registers `instance.handle`
  with the dispatcher once per event type listed.
- `ApplicationModuleHandlerScanner` walks providers for classes with
  `@ApplicationModuleHandler` metadata. Route is decided at bootstrap
  by whether `OUTBOX_LISTENER_REGISTRAR` is bound: registrar present
  → register with the outbox registry in `REQUIRES_NEW`; registrar
  absent → register with the dispatcher as AFTER_COMMIT + async in a
  fresh transaction.

**Event dispatching**:
- Publish OUTSIDE a transaction:
  - handlers with `fallbackExecution: true` are invoked directly
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
- **DO NOT publish events outside a transaction via `OutboxEventPublisher`**
  — that is a design error. Publish events inside a `@Transactional`
  method so that publication entries are committed atomically with the
  business data. (Exception: tests with the outbox disabled may call
  `publish` directly.)
- **DO NOT rename handler classes carelessly once the outbox is in use**
  — the class name is part of the listener ID
  (`${ClassName}#${EventName}`). Renaming it makes existing publications
  in the database unresolvable. Use an explicit `options.id` for
  stability:
  `@OutboxEventsHandler({ events: [SomeEvent], id: 'stable-listener-id' })`.
- **DO NOT write separate classes for `@TransactionalEventsHandler` and
  `@OutboxEventsHandler` on the same event without understanding the
  double-invocation risk** — in most cases use `@ApplicationModuleHandler`
  (the smart default) or commit to exactly one of the two.
- **DO NOT apply the `event_publication` schema in production without a
  migration** — auto schema initialization is development-only.
  Production requires an explicit migration step.

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

### Testing events and outbox

The outbox-core and cqrs packages (Phase 8) export testing utilities via
the `/testing` subpath:

- **`PublishedEvents`**: query events published during a test.
- **`AssertablePublishedEvents`**: fluent assertions on published events.
- **`InMemoryEventPublicationRepository`**: fast in-memory replacement
  for the TypeORM repository (already available from Phase 5).

Integration tests should use `testcontainers-node` for a real Postgres
specifically when testing the outbox-typeorm package. For general
application testing (even with the outbox enabled) the in-memory
repository is sufficient.

Coverage targets:
- outbox-core: 90% lines, 85% branches
- outbox-typeorm: 85% lines (the remainder is TypeORM integration that
  is hard to cover in unit tests)

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

### Phase 0: Monorepo setup (done)
- pnpm workspaces, TypeScript project references
- Jest configuration
- ESLint, Prettier
- Changesets
- CI skeleton (GitHub Actions)

### Phase 1: @nestjs-transactional/core (done)
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

### Phase 2: @nestjs-transactional/typeorm (done)
- TypeOrmTransactionAdapter
- getCurrentEntityManager, isInTransaction helpers
- TypeOrmTransactionalModule
- Multi-datasource support
- Savepoints for NESTED propagation

### Phase 3: @nestjs-transactional/cqrs (done)
- TransactionPhase enum, metadata types
- Class-level `@TransactionalEventsHandler` + `@ApplicationModuleHandler`
  decorators with `I*Handler` interfaces (see ADR-014)
- TransactionalEventDispatcher (with phase routing)
- TransactionalListenerScanner (auto-registration for
  `@TransactionalEventsHandler` classes)
- ApplicationModuleHandlerScanner (smart outbox/in-memory routing for
  `@ApplicationModuleHandler` via the `OUTBOX_LISTENER_REGISTRAR`
  structural port)
- CqrsHandlerWrapper (handler decoration at bootstrap)
- CqrsTransactionalBootstrap (OnApplicationBootstrap)
- TransactionalEventPublisher + Adapter (override of the @nestjs/cqrs
  EventPublisher)
- AggregateRoot integration (mergeObjectContext, mergeClassContext)
- CqrsTransactionalModule

### Phase 4: CI/CD and publishing (done)
- Full GitHub Actions workflow
- Release automation with changesets
- NPM publishing setup
- Documentation generation

### Phase 5: @nestjs-transactional/outbox-core (in progress)

Core infrastructure for the Event Publication Registry:
- `EventPublication` types and lifecycle states (`PUBLISHED`, `PROCESSING`,
  `COMPLETED`, `FAILED`, `RESUBMITTED`)
- `EventSerializer` abstraction with a JSON default implementation
- `EventTypeRegistry` for deserialization
- `EventPublicationRepository` SPI
- `EventPublicationRegistry` — central lifecycle coordinator
- `OutboxListenerRegistry` and the class-level `@OutboxEventsHandler`
  decorator (see ADR-014)
- `OutboxEventPublisher` — high-level API
- `EventPublicationProcessor` — async worker
- `StalenessMonitor` — detects stuck publications
- `FailedEventPublications`, `IncompleteEventPublications`,
  `CompletedEventPublications` — public APIs
- `StartupRecoveryService` — republish on restart
- `OutboxModule` (`forRoot` / `forRootAsync`), `OutboxProcessingModule`
- In-memory repository for testing

### Phase 6: @nestjs-transactional/outbox-typeorm (planned)

TypeORM persistence implementation:
- `EventPublicationEntity` with proper indexes
- `EventPublicationArchiveEntity` (for ARCHIVE completion mode)
- `TypeOrmEventPublicationRepository` implementing the SPI from outbox-core
- Uses `FOR UPDATE SKIP LOCKED` for concurrent worker safety
- Schema migration (`createEventPublication`)
- Auto schema initialization (development only)
- `OutboxTypeOrmModule`

### Phase 7: @nestjs-transactional/cqrs outbox integration (planned)

Changes to the existing cqrs package:
- `HybridEventPublisher` — delegates to both the in-memory dispatcher and
  the outbox
- `TransactionalEventPublisherAdapter` updated to use `HybridEventPublisher`
- `ApplicationModuleHandlerScanner` — smart router for
  `@ApplicationModuleHandler` classes; routes to outbox when
  `OUTBOX_LISTENER_REGISTRAR` is bound, falls back to dispatcher otherwise
- `@ApplicationModuleHandler` composite decorator (smart default)
- `OutboxEventPublisher.scheduleForPublication` for a sync publish API
  with batched writes
- `CqrsTransactionalModule` options extended for outbox config

### Phase 8: Testing utilities (planned)

In outbox-core (`/testing` subpath) and cqrs (`/testing` subpath):
- `PublishedEvents`: inspect events during tests
- `AssertablePublishedEvents` with a fluent API
- Integration with Jest
- Documentation with examples

### Phase 9: Documentation and release (planned)

- `docs/architecture/outbox-pattern.md`
- `docs/architecture/outbox-integration-with-cqrs.md`
- ADR-006 through ADR-009 (and ADR-010 from Phase 7)
- Migration guide: `@TransactionalEventsHandler` → `@OutboxEventsHandler`
- Full working example in `examples/outbox-full-stack/`
- CI updates for new packages
- Changesets for version bumps
- Update main README with the expanded roadmap

### Future phases (not scheduled)

- **@nestjs-transactional/outbox-kafka**: event externalization to Kafka
- **@nestjs-transactional/outbox-rabbitmq**: RabbitMQ externalization
- **@nestjs-transactional/outbox-prisma**: Prisma persistence backend
- **@nestjs-transactional/outbox-mongodb**: MongoDB persistence backend
- **OpenTelemetry integration**: tracing across transaction and event
  boundaries
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

**Last updated**: 2026-04-24 (Phase 9, Iteration 9.2 — class-level
handler API redesign, ADR-014).

### Completed

- Phase 0: Monorepo setup (pnpm workspaces, TypeScript project references)
- Phase 1: `@nestjs-transactional/core` (all propagation modes, decorators,
  interceptor, method bootstrap, observability)
- Phase 2: `@nestjs-transactional/typeorm` (adapter, helpers,
  multi-datasource)
- Phase 3: `@nestjs-transactional/cqrs` (phase-based dispatching,
  AggregateRoot integration, auto-wrapping)
- Phase 4: Examples and CI/CD (basic, multi-datasource, cqrs-full-stack
  examples; GitHub Actions with lint / build / test)
- Post-Phase-4 technical debt: spec files excluded from publish tarballs,
  provenance configured, coverage reporting in CI
- Phase 5: `@nestjs-transactional/outbox-core` (alpha) — types, SPI,
  event publication registry, outbox publisher, async processor,
  staleness monitor, startup recovery, operator APIs
  (Failed/Incomplete/Completed), in-memory repo, `OutboxModule` +
  `OutboxProcessingModule`. 143 unit tests.
- Phase 6: `@nestjs-transactional/outbox-typeorm` (alpha) — entities
  (hot + archive), `TypeOrmEventPublicationRepository` with
  `FOR UPDATE SKIP LOCKED`, migration + development-time
  `SchemaInitializer` (shared factory), `OutboxTypeOrmModule` +
  `typeOrmEventPublicationRepositoryProvider`. 20 integration
  tests (Postgres via testcontainers).
- Phase 7: CQRS ↔ outbox integration —
  `OutboxEventPublisher.scheduleForPublication` (sync, per-tx
  buffer via WeakMap<ActiveTransaction, events[]>,
  single beforeCommit flush hook),
  `HybridEventPublisher` with `@Optional()` outbox scheduler via
  `OUTBOX_PUBLICATION_SCHEDULER` structural token,
  `@ApplicationModuleHandler` class-level decorator with the
  dedicated `ApplicationModuleHandlerScanner` that routes to
  outbox/dispatcher based on `OUTBOX_LISTENER_REGISTRAR` binding.
- Phase 8: Testing utilities — `PublishedEvents`,
  `AssertablePublishedEvents`, `PublishedEventsAssertionError`
  exported via `/testing` subpath of outbox-core. 15 unit tests.
- Handler API redesign (ADR-014, DD-013) — migrated all three
  listener decorators from method-level to class-level, matching
  `@nestjs/cqrs` conventions. `@TransactionalEventsListener` →
  `@TransactionalEventsHandler`, `@OutboxEventListener` →
  `@OutboxEventsHandler`, `@ApplicationModuleListener` →
  `@ApplicationModuleHandler`. Listener id format changed from
  `${ClassName}.${methodName}` to `${baseId}#${EventName}`.
  Type-safety enforced via `I*Handler` interfaces. Smart
  `ApplicationModuleHandlerScanner` replaces the old
  skip-logic-by-metadata pattern.

### In Progress

- **Phase 9: Documentation & release** —
  Iteration 9.1 shipped: ADR-006 (outbox rationale), ADR-007
  (outbox architecture), `docs/architecture/outbox-pattern.md`,
  `docs/architecture/outbox-integration-with-cqrs.md`,
  `docs/guides/migrating-to-outbox.md`,
  `examples/outbox-full-stack/`, updated root README with
  roadmap and outbox packages, updated CLAUDE.md.
  Iteration 9.2 shipped: ADR-014 (class-level handler API
  redesign), migrated `@TransactionalEventsListener` →
  `@TransactionalEventsHandler`, `@OutboxEventListener` →
  `@OutboxEventsHandler`, `@ApplicationModuleListener` →
  `@ApplicationModuleHandler`, `ApplicationModuleHandlerScanner`
  smart fallback, updated READMEs, architecture docs, migration
  guide, examples.

### Blocked / Awaiting

- Pre-0.1.0 release blockers: Docker integration tests in CI,
  NPM_TOKEN setup, first changeset for outbox packages.

### Next

- Phase 9 iteration 9.3: release automation for the outbox
  packages — changeset entries, CI matrix tweaks if needed,
  first 0.1.0-alpha release.
- ADR-008 (event serialization), ADR-009 (listener id
  stability) — when the related design decisions need more room
  than the DD section. ADR-010 (hybrid event publishing)
  superseded by ADR-014, no longer planned.
- Future phases (not scheduled): outbox-kafka, outbox-rabbitmq,
  outbox-prisma, outbox-mongodb, OpenTelemetry integration,
  ESM dual packaging.

### Key recent decisions

- Scope expanded from Spring Framework parity to Spring Modulith parity
  (DD-009)
- Outbox split into core + typeorm packages (DD-010)
- Hybrid event publishing chosen over replacement (DD-011)
- `@ApplicationModuleHandler` as smart default (DD-012)
- Class-level handler API aligned with `@nestjs/cqrs` (DD-013, ADR-014)

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
