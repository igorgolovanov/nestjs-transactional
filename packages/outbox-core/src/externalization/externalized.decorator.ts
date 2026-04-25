import 'reflect-metadata';

/**
 * Metadata key under which {@link ExternalizedMetadata} is stored on
 * classes decorated with {@link Externalized}.
 *
 * Fresh `Symbol` (not `Symbol.for`) — externalization metadata is read
 * only by `ExternalizationRegistry` inside outbox-core; cross-package
 * sharing is not required.
 */
export const EXTERNALIZED_METADATA = Symbol('EXTERNALIZED_METADATA');

/**
 * Options accepted by {@link Externalized}. The optional `TEvent`
 * generic types the `routingKey` and `headers` callbacks so users get
 * IDE assistance when extracting fields from the event:
 *
 * ```ts
 * @Externalized<OrderPlacedEvent>({
 *   target: 'orders',
 *   routingKey: (e) => e.tenantId, // `e` is OrderPlacedEvent
 * })
 * class OrderPlacedEvent { ... }
 * ```
 *
 * The generic is erased at storage time — the
 * {@link ExternalizationRegistry} sees the callbacks as `(event:
 * unknown) => ...` (see {@link ExternalizedMetadata}).
 */
export interface ExternalizedOptions<TEvent = unknown> {
  /**
   * Broker-side destination — Kafka topic, RabbitMQ exchange, NATS
   * subject, gRPC service, etc. Required, must be a non-empty string.
   * Interpretation is delegated to the
   * `EventExternalizer` implementation.
   */
  readonly target: string;
  /**
   * Optional override for which `ClientProxy` registration the
   * externalizer should use when more than one is bound. Resolution
   * semantics are owned by the externalizer; `outbox-microservices`
   * (Phase 11.3) interprets it as a token in the user's
   * `ClientsModule` registration (DD-017).
   */
  readonly client?: string | symbol;
  /**
   * Optional callback that derives a routing key from the event
   * instance. Used by brokers that support secondary routing
   * (RabbitMQ routing key, Kafka message key, ...). Implementations
   * that do not understand routing keys ignore the field.
   */
  readonly routingKey?: (event: TEvent) => string;
  /**
   * Optional message headers. Either a static record, or a callback
   * that derives headers from the event instance.
   */
  readonly headers?: Record<string, string> | ((event: TEvent) => Record<string, string>);
}

/**
 * Stored shape of {@link ExternalizedOptions} after decoration. The
 * `TEvent` generic from the input is erased — callbacks accept
 * `unknown` and are invoked with the original event instance by
 * {@link ExternalizationRegistry.buildMetadata}.
 */
export interface ExternalizedMetadata {
  readonly target: string;
  readonly client?: string | symbol;
  readonly routingKey?: (event: unknown) => string;
  readonly headers?: Record<string, string> | ((event: unknown) => Record<string, string>);
}

/**
 * Mark an event class for externalization to a message broker.
 *
 * After a local outbox listener completes successfully for a
 * publication of this event type, the
 * `EventPublicationProcessor` invokes the bound
 * `EventExternalizer` (see DD-018) with the resolved
 * {@link ExternalizationMetadata}. Reliability — retry on broker
 * failure, recovery on restart — is provided by the existing outbox
 * machinery (single-unit atomicity per DD-019). For Phase 11.1 / 11.2
 * the actual broker delivery requires a concrete externalizer
 * implementation (e.g.
 * `@nestjs-transactional/outbox-microservices`, Phase 11.3); without
 * one, decorated events are processed locally and the externalization
 * step is skipped without error.
 *
 * @throws {Error} If `target` is missing, not a string, or empty.
 *
 * @example
 * Static target:
 * ```ts
 * @Externalized({ target: 'orders.placed' })
 * export class OrderPlacedEvent {
 *   constructor(public readonly orderId: string) {}
 * }
 * ```
 *
 * @example
 * Per-event routing key and headers:
 * ```ts
 * @Externalized<OrderPlacedEvent>({
 *   target: 'orders',
 *   routingKey: (e) => e.tenantId,
 *   headers: (e) => ({ 'x-correlation-id': e.correlationId }),
 *   client: 'KAFKA_CLIENT', // forwarded to the externalizer
 * })
 * export class OrderPlacedEvent {
 *   constructor(
 *     readonly orderId: string,
 *     readonly tenantId: string,
 *     readonly correlationId: string,
 *   ) {}
 * }
 * ```
 */
export function Externalized<TEvent = unknown>(
  options: ExternalizedOptions<TEvent>,
): ClassDecorator {
  if (typeof options.target !== 'string' || options.target.length === 0) {
    throw new Error('@Externalized requires "target" option as a non-empty string');
  }

  // The `TEvent` generic is erased on storage — the registry invokes
  // callbacks with `unknown` and passes the original event instance
  // captured at publish time.
  const metadata: ExternalizedMetadata = {
    target: options.target,
    client: options.client,
    routingKey: options.routingKey as ((event: unknown) => string) | undefined,
    headers: options.headers as
      | Record<string, string>
      | ((event: unknown) => Record<string, string>)
      | undefined,
  };

  return (target: object): void => {
    Reflect.defineMetadata(EXTERNALIZED_METADATA, metadata, target);
  };
}

/**
 * Read the {@link ExternalizedMetadata} attached to `target` by
 * {@link Externalized}. Returns `undefined` when the class was not
 * decorated.
 */
export function getExternalizedMetadata(target: object): ExternalizedMetadata | undefined {
  const value: unknown = Reflect.getMetadata(EXTERNALIZED_METADATA, target);
  return value as ExternalizedMetadata | undefined;
}
