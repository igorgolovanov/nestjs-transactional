# ADR-005: Method Wrapping Strategy for @Transactional

## Status
Accepted — 2026-04-23

## Context

The `@Transactional()` decorator must wrap methods in a transaction context.
NestJS provides several possible mechanisms for intercepting method calls:

1. **NestJS Interceptors** (via `APP_INTERCEPTOR`) — only fire at the request
   boundary: controllers, resolvers, gateways, message patterns.

2. **Prototype method wrapping inside the decorator** — the decorator directly
   replaces `descriptor.value` with a wrapper. Problem: there is no access to
   the DI container to obtain a `TransactionManager`.

3. **Runtime wrapping via DiscoveryService** — a service scans all providers at
   `OnApplicationBootstrap` and wraps methods at the instance level.

No single mechanism covers all cases on its own. `@Injectable` services are not
caught by interceptors. Decorators cannot resolve DI. Runtime wrapping does not
work for controllers (they already have the NestJS request pipeline).

## Decision

The `@Transactional` decorator is **metadata-only**. It does not modify the
method; it only writes metadata via `Reflect.defineMetadata(TRANSACTIONAL_METADATA, ...)`.

Actual wrapping is performed by **three coordinated mechanisms**, each for its
own context:

### 1. TransactionalInterceptor (via APP_INTERCEPTOR)
For the **request boundary**: controllers, resolvers, gateways, message
patterns. Reads metadata from the handler via `Reflector` and wraps the call in
`manager.run()`. Registered automatically in `TransactionalModule.forRoot()`
(opt-out via `registerInterceptor: false`).

### 2. TransactionalMethodsBootstrap (via OnApplicationBootstrap)
For **regular `@Injectable` services**. At `OnApplicationBootstrap`:
- Scans all providers via `DiscoveryService` + `MetadataScanner`
- For each method carrying `@Transactional` metadata — wraps
  `instance[methodName]` via a closure that calls `manager.run()`
- Skips classes with NestJS controller/resolver/gateway metadata (handled by
  the Interceptor)
- Skips CQRS handler classes (handled by `CqrsHandlerWrapper`)
- Opt-out via `useMethodBootstrap: false` in module options

### 3. CqrsHandlerWrapper (via OnApplicationBootstrap, in @nestjs-transactional/cqrs)
Specialization for `@CommandHandler`, `@QueryHandler`, `@EventsHandler`.
Logically analogous to `TransactionalMethodsBootstrap`, but works specifically
with the `execute()` method of handlers and integrates with
`TransactionalEventPublisher` for `AggregateRoot` events.

## Coordination between mechanisms

Double-wrapping is prevented via a **wrapping marker**:

```typescript
const WRAPPED_MARKER = Symbol.for('@nestjs-transactional/wrapped');

// Before wrapping
if (Reflect.getMetadata(WRAPPED_MARKER, instance[methodName]) === true) {
  return;  // already wrapped
}

// After wrapping
Reflect.defineMetadata(WRAPPED_MARKER, true, wrapped);
instance[methodName] = wrapped;
```

Reasons for choosing `Reflect.defineMetadata` over an instance-level `WeakSet`:

- **Stateless**: the marker lives on the method itself, not on an external
  tracker
- **Test-safe**: when `TestingModule` is recreated, the metadata is
  overwritten along with fresh methods
- **No cross-instance leakage**: each created class/method gets its own
  marker independently of the history of other instances
- **`Symbol.for`** provides a shared symbol to handle the edge case of two
  versions of the package in the same dependency tree

Fallback: if a method is somehow wrapped twice (bypassing the marker),
propagation mode `REQUIRED` guarantees correct behavior — the existing
transaction is reused and no second transaction is started.

## Alternatives Considered

### Interceptor only
Does not cover service-to-service calls. Rejected.

### Prototype wrapping inside the decorator
Requires either a global singleton `TransactionManager` (anti-pattern,
breaks DI) or lazy resolution via `Inject.get()` (complexity, race conditions
during concurrent initialization). Rejected.

### Single universal bootstrap without an interceptor
Does not work for controllers — NestJS creates an `ExecutionContext` for the
request pipeline, and the interceptor-based approach is more natural for
request handling (better integration with exception filters, guards, pipes).
Rejected in favour of the combined approach.

### WeakSet-based wrapping tracking
Storing wrapped methods in a `WeakSet<Function>` inside
`TransactionalMethodsBootstrap`. Issues: state lives on the service instance,
of which many may be created during frequent `Test.createTestingModule()` calls;
the "is it wrapped?" check logic becomes more complex because both the original
and the wrapper must be tracked. Rejected in favour of the Reflect metadata
marker.

## Consequences

### Positive
- Unified API for users: `@Transactional()` "just works" everywhere
- Clean separation of concerns: each mechanism does one thing
- Testability: each wrapper can be disabled via module options for isolated
  unit testing
- Test-safe: marker-based tracking is stateless

### Negative
- More infrastructure code (3 components instead of 1)
- Debugging "why isn't it wrapped?" requires familiarity with all three
  mechanisms
- Runtime wrapping via `DiscoveryService` makes debugging slightly less
  straightforward (instance methods differ from prototype methods)

### Mitigations
- Each mechanism lives in a separate file with a clear name
- Debug-level logging at wrap time: `"Wrapped method X.Y with metadata
  {propagation: 'REQUIRED'}"`
- This ADR documents the decision; future questions can be resolved by
  referring back to it
