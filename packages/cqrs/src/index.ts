export { TransactionPhase } from './types/transactional-listener.types.js';

export {
  TRANSACTIONAL_EVENTS_HANDLER_METADATA,
  TransactionalEventsHandler,
  getTransactionalEventsHandlerMetadata,
  type TransactionalEventsHandlerMetadata,
  type TransactionalEventsHandlerOptions,
} from './decorators/transactional-events-handler.decorator.js';

export {
  INTEGRATION_EVENTS_HANDLER_METADATA,
  IntegrationEventsHandler,
  getIntegrationEventsHandlerMetadata,
  type IntegrationEventsHandlerMetadata,
  type IntegrationEventsHandlerOptions,
} from './decorators/integration-events-handler.decorator.js';

export type { ITransactionalEventHandler } from './interfaces/transactional-event-handler.interface.js';
export type { IIntegrationEventHandler } from './interfaces/integration-event-handler.interface.js';

export {
  TransactionalEventDispatcher,
  type DispatcherListenerMetadata,
} from './event-dispatcher/event-dispatcher.js';

export { TransactionalListenerScanner } from './handlers/listener-scanner.js';
export { IntegrationEventsHandlerScanner } from './handlers/integration-events-handler-scanner.js';
export {
  OUTBOX_LISTENER_REGISTRAR,
  type OutboxListenerRegistrar,
} from './handlers/outbox-listener-registrar.js';

export {
  CQRS_HANDLER_WRAPPER_OPTIONS,
  CqrsHandlerWrapper,
  type HandlerWrapperOptions,
} from './handlers/handler-wrapper.js';

export { CqrsTransactionalBootstrap } from './handlers/bootstrap.js';

export { TransactionalEventPublisher } from './event-publisher/transactional-event-publisher.js';
export {
  type AggregateConstructor,
  TransactionalEventPublisherAdapter,
} from './event-publisher/transactional-event-publisher-adapter.js';
export {
  HybridEventPublisher,
  OUTBOX_PUBLICATION_SCHEDULER,
  type OutboxPublicationScheduler,
} from './event-publisher/hybrid-event-publisher.js';

export {
  CQRS_TRANSACTIONAL_OPTIONS,
  CqrsTransactionalModule,
  type CqrsTransactionalAsyncFactoryResult,
  type CqrsTransactionalAsyncOptions,
  type CqrsTransactionalOptions,
} from './module/cqrs-transactional.module.js';
