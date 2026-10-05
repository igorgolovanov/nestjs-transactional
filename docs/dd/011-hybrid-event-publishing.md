# DD-011: Hybrid event publishing (in-memory + persistent coexistence)

> **Superseded from 3.0.0** by [DD-029](./029-cqrs-publisher-chain-contract.md): events go through the `@nestjs/cqrs` `EventBus`, and `HybridEventPublisher` is gone (ADR-024). Kept as the record of how 2.x works.

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
`@IntegrationEventsHandler` is routed by a separate smart scanner
(see [DD-013](013-class-level-handler-api.md) and
[ADR-014](../adr/014-handler-api-redesign.md)) — the old
"two metadata keys + skip logic" approach from the original design
has been removed.

**Consequences**: Seamless coexistence. Developers must understand
which decorator provides which guarantees — see "Delivery guarantees
at a glance" in `packages/cqrs/README.md`.
