import 'reflect-metadata';

/** Reflect-metadata key under which {@link Externalized} stores its options. */
export const EXTERNALIZED_METADATA = Symbol('EXTERNALIZED_METADATA');

export interface ExternalizedOptions<TEvent = unknown> {
  /**
   * The message topic: what `@nestjs/outbox` stores, what
   * `ClientProxyTransport` passes to `client.emit()` as the pattern, and
   * so the Kafka topic, RabbitMQ pattern or NATS subject. Required.
   */
  readonly target: string;
  /**
   * The `@nestjs/outbox` transport that delivers this event: a key of
   * `OutboxModule`'s `transports`, conventionally the `ClientsModule`
   * token it wraps. Omit it to use `externalizedRoute`'s
   * `defaultTransport`.
   *
   * `'local'` is `@nestjs/outbox`'s in-process transport. It is how an
   * event applied by an aggregate gets durable delivery to
   * `@OnOutboxMessage` handlers, since `AggregateRoot.commit()` takes
   * only `@Externalized` events into the outbox (DD-028).
   */
  readonly client?: string;
  /**
   * Derives the message `key`. Messages sharing a key are delivered in
   * commit order, and `toKafkaPacket` makes it the Kafka message key.
   */
  readonly routingKey?: (event: TEvent) => string;
  /** Message headers, static or derived from the event. */
  readonly headers?: Record<string, string> | ((event: TEvent) => Record<string, string>);
}

export interface ExternalizedMetadata {
  readonly target: string;
  readonly client?: string;
  readonly routingKey?: (event: unknown) => string;
  readonly headers?: Record<string, string> | ((event: unknown) => Record<string, string>);
}

/** Where messages for one externalized target go. */
export interface ExternalizedRoute {
  readonly client?: string;
}

/**
 * Thrown at decoration time when two event classes declare the same
 * `target` with different clients. A topic can only be routed one way,
 * so the conflict is reported where it is written, not when the first
 * message of one of them is dead-lettered.
 */
export class ExternalizedRouteConflictError extends Error {
  constructor(
    readonly target: string,
    readonly existing: string | undefined,
    readonly attempted: string | undefined,
  ) {
    super(
      `@Externalized target '${target}' is already routed to ${describe(existing)}; ` +
        `it cannot also be routed to ${describe(attempted)}. Give one of the events ` +
        `its own target, or the same client.`,
    );
    this.name = 'ExternalizedRouteConflictError';
  }
}

const routes = new Map<string, ExternalizedRoute>();

/**
 * Marks an event class for delivery to a broker through `@nestjs/outbox`.
 * `OutboxEventPublisher.publish()` turns an instance into an outbox
 * message on `target`, with `routingKey` as its key and `headers` as its
 * headers (DD-028).
 *
 * @example
 * ```ts
 * @Externalized<OrderPlaced>({
 *   target: 'orders.placed',
 *   client: 'KAFKA',
 *   routingKey: (e) => e.orderId,
 * })
 * export class OrderPlaced { constructor(readonly orderId: string) {} }
 * ```
 */
export function Externalized<TEvent = unknown>(
  options: ExternalizedOptions<TEvent>,
): ClassDecorator {
  if (typeof options.target !== 'string' || options.target.length === 0) {
    throw new Error('@Externalized requires "target" option as a non-empty string');
  }

  const metadata: ExternalizedMetadata = {
    target: options.target,
    client: options.client,
    routingKey: options.routingKey as ((event: unknown) => string) | undefined,
    headers: options.headers as
      Record<string, string> | ((event: unknown) => Record<string, string>) | undefined,
  };

  return (target: object): void => {
    const existing = routes.get(metadata.target);
    if (existing !== undefined && existing.client !== metadata.client) {
      throw new ExternalizedRouteConflictError(metadata.target, existing.client, metadata.client);
    }
    routes.set(metadata.target, { client: metadata.client });
    Reflect.defineMetadata(EXTERNALIZED_METADATA, metadata, target);
  };
}

/** The {@link ExternalizedMetadata} of an event class, or `undefined`. */
export function getExternalizedMetadata(target: object): ExternalizedMetadata | undefined {
  return Reflect.getMetadata(EXTERNALIZED_METADATA, target) as ExternalizedMetadata | undefined;
}

/**
 * Every externalized target seen so far, with its route. Filled as
 * decorated classes are evaluated, so it is complete once the event
 * modules have been imported, which happens before any message exists.
 */
export function externalizedRoutes(): ReadonlyMap<string, ExternalizedRoute> {
  return routes;
}

function describe(client: string | undefined): string {
  return client === undefined ? 'the default transport' : `client '${client}'`;
}
