/** Options of `TransactionalOutboxModule.forRoot()`. */
export const TRANSACTIONAL_OUTBOX_OPTIONS = Symbol('TRANSACTIONAL_OUTBOX_OPTIONS');

/**
 * The cqrs `TransactionalEventBusPublisher`'s scheduler port. A `Symbol.for` key,
 * so this package binds it without depending on
 * `@nestjs-transactional/cqrs`; that package defines the same key.
 */
export const OUTBOX_PUBLICATION_SCHEDULER = Symbol.for(
  '@nestjs-transactional/cqrs/outbox-publication-scheduler',
);
