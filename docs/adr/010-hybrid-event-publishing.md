# ADR-010: Hybrid event publishing — superseded by ADR-014

## Status

Superseded by [ADR-014](014-handler-api-redesign.md) — 2026-04-27.

## Context

This ADR slot was reserved during Phase 7 (CQRS ↔ outbox
integration, see CLAUDE.md "Phase 7" entry) to capture the
"hybrid event publisher" design — a single `HybridEventPublisher`
that fans `AggregateRoot` events to BOTH the in-memory
transactional dispatcher (`TransactionalEventDispatcher`) AND the
outbox (`OutboxEventPublisher.scheduleForPublication`) in one
publish call, so users wouldn't need to choose between the two
delivery channels at the call site.

The design landed in code in Phase 7 as `HybridEventPublisher`,
but the standalone ADR was never written. Several of its
intended decisions — choice of "fan to both" over "fan to one
based on listener metadata", the structural-port pattern for
`OUTBOX_PUBLICATION_SCHEDULER` and `OUTBOX_LISTENER_REGISTRAR`,
the smart routing of `@IntegrationEventsHandler` based on which
of those tokens is bound — got absorbed into a broader redesign
of the listener API in Phase 10.

That redesign is captured by [ADR-014](014-handler-api-redesign.md),
which carries a `Supersedes: ADR-010` note in its frontmatter.

## Decision

Do not write a separate ADR-010. The decisions originally
intended for this slot are recorded in
[ADR-014](014-handler-api-redesign.md) — specifically:

- The `HybridEventPublisher` pattern of fan-to-both
  (in-memory dispatcher + outbox).
- The `OUTBOX_PUBLICATION_SCHEDULER` and
  `OUTBOX_LISTENER_REGISTRAR` structural ports
  ([DD-011](../dd/011-hybrid-event-publishing.md),
  [DD-012](../dd/012-integration-events-handler.md)).
- The smart routing of `@IntegrationEventsHandler` based on
  whether the `OUTBOX_LISTENER_REGISTRAR` is bound at runtime.
- The class-level handler API redesign that subsumes the
  Phase-7 decorator shapes.

This stub exists to preserve the ADR numbering contract
(allocated numbers do not get reused) and to redirect readers to
the canonical record. Implementation details of the hybrid
publishing flow are in
`packages/cqrs/src/event-publisher/hybrid-event-publisher.ts`
and `packages/cqrs/README.md` (the "Delivery guarantees at a
glance" section).

## Notes

- See ADR-014's "Supersedes" note (line 5 of that file) for the
  cross-link from the surviving ADR.
- See [DD-011](../dd/011-hybrid-event-publishing.md) (Hybrid event
  publishing) and [DD-012](../dd/012-integration-events-handler.md)
  (`@IntegrationEventsHandler` as smart default)
  for the design-decision-level rationale that complements
  ADR-014.
