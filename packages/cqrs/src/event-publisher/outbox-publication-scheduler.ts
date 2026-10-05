/**
 * Minimal structural contract for the outbox side of
 * {@link TransactionalEventBusPublisher}. Declared here rather than
 * imported from `@nestjs-transactional/outbox`, so cqrs works without the
 * outbox.
 *
 * `@nestjs-transactional/outbox`'s `OutboxEventPublisher` implements it,
 * and `TransactionalOutboxModule.forRoot()` binds it to
 * {@link OUTBOX_PUBLICATION_SCHEDULER} by itself.
 */
export interface OutboxPublicationScheduler {
  scheduleForPublication(event: unknown): void;
}

/**
 * DI token for the optional outbox scheduler. When unbound, events reach
 * only the in-memory phase handlers and the `EventBus`.
 *
 * A `Symbol.for` key: `@nestjs-transactional/outbox` binds the same key
 * without depending on this package.
 */
export const OUTBOX_PUBLICATION_SCHEDULER = Symbol.for(
  '@nestjs-transactional/cqrs/outbox-publication-scheduler',
);
