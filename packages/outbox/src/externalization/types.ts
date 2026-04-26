/**
 * Metadata describing how a single event should be routed to an
 * external message broker.
 *
 * Produced by the `ExternalizationRegistry` (Phase 11.2) by resolving
 * the event's class against the metadata stored by the `@Externalized`
 * decorator. Consumed by an {@link EventExternalizer} implementation
 * (e.g. `MicroservicesEventExternalizer` from
 * `@nestjs-transactional/outbox-microservices`, Phase 11.3) which
 * translates the abstract `target` / `routingKey` / `headers` shape
 * into transport-specific calls.
 *
 * Field semantics:
 * - `eventType` matches `EventPublication.eventType` and is filled in
 *   for diagnostics — externalizer implementations should not need to
 *   re-derive it from the payload.
 * - `target` is the broker-side destination (Kafka topic, RabbitMQ
 *   exchange, NATS subject, gRPC method, ...). Interpretation is
 *   delegated to the externalizer.
 * - `routingKey` is the optional sub-routing token for brokers that
 *   support it (RabbitMQ routing key, Kafka partition key when used
 *   that way). Implementations that do not understand routing keys
 *   should ignore the field.
 * - `headers` is an optional flat string map propagated to the
 *   transport's headers / metadata if the transport supports them.
 * - `client` is an optional override for which `ClientProxy`
 *   registration the externalizer should use when more than one is
 *   bound. Resolution semantics are owned by the externalizer
 *   implementation — `outbox-microservices` interprets it as a token
 *   in the user's `ClientsModule` registration (DD-017).
 */
export interface ExternalizationMetadata {
  readonly eventType: string;
  readonly target: string;
  readonly routingKey?: string;
  readonly headers?: Record<string, string>;
  readonly client?: string | symbol;
}
