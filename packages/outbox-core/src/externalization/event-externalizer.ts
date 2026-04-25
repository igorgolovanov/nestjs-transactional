import type { ExternalizationMetadata } from './types';

/**
 * SPI for routing events that have an `@Externalized` mapping to an
 * external message broker.
 *
 * Implementations are provided by extension packages — primarily
 * `@nestjs-transactional/outbox-microservices` (Phase 11.3), which
 * delegates to `@nestjs/microservices` `ClientProxy` and therefore
 * covers every transport that NestJS already supports (Kafka,
 * RabbitMQ, NATS, JMS, gRPC, custom). Future native (broker-specific)
 * adapters can register under the same {@link EVENT_EXTERNALIZER}
 * token without touching `outbox-core`.
 *
 * `EventPublicationProcessor` invokes `externalize()` AFTER the local
 * outbox listener has succeeded for the publication and BEFORE the
 * publication is finalized as `COMPLETED` (DD-019). If `externalize()`
 * rejects, the publication is recorded as `FAILED` and can be
 * resubmitted via {@link FailedEventPublications.resubmit} — the
 * single-unit atomicity contract from DD-019 means a successful local
 * listener may run again on retry, hence the documented idempotency
 * requirement on listeners.
 *
 * Errors surface to the processor as ordinary rejections; wrap
 * transport-specific failures in {@link ExternalizationError} for
 * structured diagnostics if needed.
 */
export interface EventExternalizer {
  /**
   * Route the event to its broker-side target.
   *
   * @param event Deserialized event payload (the same instance that
   *   was passed to the local listener).
   * @param metadata Resolved routing metadata for this event. The
   *   processor obtains it from the `ExternalizationRegistry`
   *   (Phase 11.2).
   */
  externalize(event: unknown, metadata: ExternalizationMetadata): Promise<void>;
}

/**
 * DI token for {@link EventExternalizer} bindings.
 *
 * Consumed by `EventPublicationProcessor` via `@Optional()` injection
 * (DD-018) — the outbox runs in internal-only mode when no
 * implementation is bound. Bind a concrete implementation via
 * `useClass`, `useExisting`, or `useFactory` in the application's
 * module configuration.
 */
export const EVENT_EXTERNALIZER = Symbol('EVENT_EXTERNALIZER');
