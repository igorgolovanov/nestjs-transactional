# DD-002: We do not fork @nestjs/cqrs

**Alternatives**:
- Fork @nestjs/cqrs with our changes
- Our own CQRS-like package

**Choice**: work on top of the original `@nestjs/cqrs` via:
- Runtime wrapping of handlers (replacing the `execute` method on instances)
- Override of EventPublisher through DI
- Our own TransactionalEventDispatcher alongside the original EventBus

**Trade-off**: we depend on `@nestjs/cqrs` internals (they can change). But
we don't have to maintain a fork, and users get the normal upgrade path.

> See also: [ADR-003](../adr/003-not-patching-nestjs-cqrs.md) for the
> ADR-form record of this decision.
