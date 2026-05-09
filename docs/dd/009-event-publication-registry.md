# DD-009: Implement full Event Publication Registry (Spring Modulith parity)

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
separate `outbox` + `outbox-typeorm` packages. Integration with cqrs
via `HybridEventPublisher` and the `@IntegrationEventsHandler` decorator.

**Consequences**:
- Significant scope expansion (~3 weeks of work).
- Production-ready delivery guarantees.
- Clear migration path from in-memory `@TransactionalEventsHandler` to
  persistent `@OutboxEventsHandler`.
- Larger surface area to maintain.

> See also: [ADR-006](../adr/006-outbox-pattern.md) for the ADR-form
> record of the outbox pattern decision.
