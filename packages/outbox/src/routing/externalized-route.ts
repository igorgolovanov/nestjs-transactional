import type { OutboxEnvelope, OutboxMessage } from '@nestjs/outbox';

import { externalizedRoutes } from '../externalization/externalized.decorator.js';

export interface ExternalizedRouteOptions {
  /**
   * Transport for an `@Externalized` target that names no `client`.
   * Without it, such a message fails its routing, and so dead-letters,
   * rather than going anywhere by guess.
   */
  readonly defaultTransport?: string;
  /** Transport for every other topic. Defaults to `'local'`. */
  readonly fallback?: string;
}

/**
 * Builds `OutboxModule`'s `route` from the `@Externalized` declarations:
 * an externalized target goes to its `client`, everything else to
 * `fallback`, which is `@nestjs/outbox`'s in-process `local` transport
 * unless set.
 *
 * @example
 * ```ts
 * OutboxModule.forRoot({
 *   transports: { KAFKA: ClientProxyTransport('KAFKA', { toPacket: toKafkaPacket }) },
 *   route: externalizedRoute(),
 * })
 * ```
 */
export function externalizedRoute(
  options: ExternalizedRouteOptions = {},
): (message: OutboxMessage) => string {
  const fallback = options.fallback ?? 'local';
  return (message) => {
    const route = externalizedRoutes().get(message.topic);
    if (route === undefined) {
      return fallback;
    }
    if (route.client !== undefined) {
      return route.client;
    }
    if (options.defaultTransport !== undefined) {
      return options.defaultTransport;
    }
    throw new Error(
      `@Externalized target '${message.topic}' names no client, and externalizedRoute() ` +
        `has no defaultTransport. Set one of them.`,
    );
  };
}

/** The Kafka record `ClientKafka.emit()` sends when given `{ key, value, headers }`. */
export interface KafkaOutboxPacket {
  readonly pattern: string;
  readonly data: {
    readonly key?: string;
    readonly value: OutboxEnvelope;
    readonly headers: Record<string, string>;
  };
}

/**
 * `toPacket` for `ClientProxyTransport` over Kafka. The message key
 * becomes the Kafka key, so partitioning follows `routingKey`; the
 * headers become Kafka headers, with the outbox id as `x-outbox-id`; and
 * the value is the full envelope, so consumers keep the id to
 * deduplicate on.
 *
 * Without it, the envelope is the value and the Kafka key is empty, so
 * per-key order holds only up to the broker.
 */
export function toKafkaPacket(message: OutboxMessage, envelope: OutboxEnvelope): KafkaOutboxPacket {
  return {
    pattern: message.topic,
    data: {
      ...(envelope.key === null ? {} : { key: envelope.key }),
      value: envelope,
      headers: { ...envelope.headers, 'x-outbox-id': envelope.id },
    },
  };
}
