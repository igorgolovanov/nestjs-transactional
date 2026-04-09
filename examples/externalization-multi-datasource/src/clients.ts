/**
 * Two `ClientProxy` registrations on a single RabbitMQ broker, each
 * pointing at a different queue. Per-event `@Externalized({ client })`
 * picks which queue an event lands on; that decision is decoupled
 * from which DataSource owns the event's outbox row.
 *
 * Two axes, orthogonal:
 *
 *   - **Per-DataSource outbox stack** — `OutboxModule.forFeature(...,
 *     { dataSource })` (Phase 14.3.2 / ADR-019)
 *   - **Per-event broker** — `@Externalized({ client })` (Phase 11.3)
 *
 * In this example the axes happen to align (each DS publishes events
 * routed to its own broker queue), but they don't have to. A single
 * DS could publish events to multiple brokers; multiple DSes could
 * share a broker.
 */
export const BILLING_BROKER = 'BILLING_BROKER';
export const INVENTORY_BROKER = 'INVENTORY_BROKER';
