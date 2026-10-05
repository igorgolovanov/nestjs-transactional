export {
  EXTERNALIZED_METADATA,
  Externalized,
  type ExternalizedMetadata,
  type ExternalizedOptions,
  type ExternalizedRoute,
  ExternalizedRouteConflictError,
  externalizedRoutes,
  getExternalizedMetadata,
} from './externalization/externalized.decorator.js';
export {
  EVENT_TYPE_HEADER,
  OutboxEventPublisher,
  type OutboxTransactionResolver,
  type TransactionalOutboxOptions,
} from './publisher/outbox-event-publisher.js';
export {
  externalizedRoute,
  type ExternalizedRouteOptions,
  type KafkaOutboxPacket,
  toKafkaPacket,
} from './routing/externalized-route.js';
export { TransactionalOutboxModule } from './module/transactional-outbox.module.js';
export { OUTBOX_PUBLICATION_SCHEDULER, TRANSACTIONAL_OUTBOX_OPTIONS } from './module/tokens.js';
