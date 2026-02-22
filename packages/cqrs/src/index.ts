export { TransactionPhase } from './types/transactional-listener.types';

export {
  TRANSACTIONAL_EVENTS_HANDLER_METADATA,
  TransactionalEventsHandler,
  getTransactionalEventsHandlerMetadata,
  type TransactionalEventsHandlerMetadata,
  type TransactionalEventsHandlerOptions,
} from './decorators/transactional-events-handler.decorator';

export {
  INTEGRATION_EVENTS_HANDLER_METADATA,
  IntegrationEventsHandler,
  getIntegrationEventsHandlerMetadata,
  type IntegrationEventsHandlerMetadata,
  type IntegrationEventsHandlerOptions,
} from './decorators/integration-events-handler.decorator';

export type { ITransactionalEventsHandler } from './interfaces/transactional-events-handler.interface';
export type { IIntegrationEventsHandler } from './interfaces/integration-events-handler.interface';

export {
  TransactionalEventDispatcher,
  type DispatcherListenerMetadata,
} from './event-dispatcher/event-dispatcher';

export { TransactionalListenerScanner } from './handlers/listener-scanner';
export { IntegrationEventsHandlerScanner } from './handlers/integration-events-handler-scanner';
export {
  OUTBOX_LISTENER_REGISTRAR,
  type OutboxListenerRegistrar,
} from './handlers/outbox-listener-registrar';

export {
  CQRS_HANDLER_WRAPPER_OPTIONS,
  CqrsHandlerWrapper,
  type HandlerWrapperOptions,
} from './handlers/handler-wrapper';

export { CqrsTransactionalBootstrap } from './handlers/bootstrap';

export { TransactionalEventPublisher } from './event-publisher/transactional-event-publisher';
export { TransactionalEventPublisherAdapter } from './event-publisher/transactional-event-publisher-adapter';
export {
  HybridEventPublisher,
  OUTBOX_PUBLICATION_SCHEDULER,
  type OutboxPublicationScheduler,
} from './event-publisher/hybrid-event-publisher';

export {
  CQRS_TRANSACTIONAL_OPTIONS,
  CqrsTransactionalModule,
  type CqrsTransactionalOptions,
} from './module/cqrs-transactional.module';
