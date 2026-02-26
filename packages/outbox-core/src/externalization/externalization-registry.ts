import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { EventTypeRegistry } from '../serialization/event-type-registry';

import {
  type ExternalizedMetadata,
  getExternalizedMetadata,
} from './externalized.decorator';
import type { ExternalizationMetadata } from './types';

/**
 * Registry mapping event type names to their {@link ExternalizedMetadata}.
 *
 * Built by scanning {@link EventTypeRegistry} at module init: every
 * registered class that carries `@Externalized` metadata is indexed
 * by its constructor name (matching `EventPublication.eventType`).
 * Event classes registered AFTER `onModuleInit` (e.g. via
 * `EventTypeRegistry.register` from a custom provider's
 * `OnApplicationBootstrap`) will not appear in the index — register
 * event types via `OutboxModule.forRoot({ eventTypes: [...] })` or as
 * a side effect of an earlier provider so they are present before
 * this registry initialises.
 *
 * Consumed by `EventPublicationProcessor.tryExternalize` to resolve
 * the per-publication {@link ExternalizationMetadata} that the bound
 * `EventExternalizer` then translates into a transport-specific call.
 *
 * Always provided by `OutboxModule`. When no events are decorated
 * with `@Externalized` the registry is simply empty — `get()` returns
 * `undefined` for every type and the externalization step in the
 * processor becomes a no-op.
 */
@Injectable()
export class ExternalizationRegistry implements OnModuleInit {
  private readonly logger = new Logger(ExternalizationRegistry.name);
  private readonly mapping = new Map<string, ExternalizedMetadata>();

  constructor(private readonly eventTypeRegistry: EventTypeRegistry) {}

  onModuleInit(): void {
    for (const [name, type] of this.eventTypeRegistry.getAll()) {
      const metadata = getExternalizedMetadata(type);
      if (metadata !== undefined) {
        this.mapping.set(name, metadata);
        this.logger.debug(
          `Registered externalization for ${name} → ${metadata.target}`,
        );
      }
    }

    if (this.mapping.size > 0) {
      this.logger.log(
        `Externalization configured for ${this.mapping.size} event type(s)`,
      );
    }
  }

  /** Resolve {@link ExternalizedMetadata} for an event type, or `undefined`. */
  get(eventType: string): ExternalizedMetadata | undefined {
    return this.mapping.get(eventType);
  }

  /** Whether the given event type has an `@Externalized` mapping. */
  has(eventType: string): boolean {
    return this.mapping.has(eventType);
  }

  /**
   * Build the per-publication {@link ExternalizationMetadata} that the
   * processor passes to the bound `EventExternalizer`. Resolves
   * dynamic `routingKey` and `headers` callbacks by invoking them with
   * the actual event instance.
   *
   * @returns Resolved metadata, or `undefined` if `eventType` has no
   * `@Externalized` mapping (the processor then skips the
   * externalization call entirely).
   */
  buildMetadata(eventType: string, event: unknown): ExternalizationMetadata | undefined {
    const config = this.mapping.get(eventType);
    if (config === undefined) {
      return undefined;
    }

    const headers =
      typeof config.headers === 'function' ? config.headers(event) : config.headers;

    return {
      eventType,
      target: config.target,
      client: config.client,
      routingKey: config.routingKey?.(event),
      headers,
    };
  }
}

/**
 * DI token for {@link ExternalizationRegistry}. Use the class token
 * for direct injection — this Symbol is available for code that
 * prefers token-based wiring or needs to override the registry in
 * tests.
 */
export const EXTERNALIZATION_REGISTRY = Symbol('EXTERNALIZATION_REGISTRY');
