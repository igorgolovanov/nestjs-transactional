# DD-008: Method wrapping via a triad of mechanisms

**See also**: [ADR-005](../adr/005-method-wrapping-strategy.md) for
detailed rationale.

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
