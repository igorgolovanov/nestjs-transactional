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
  CQRS_HANDLER_WRAPPER_OPTIONS,
  CqrsHandlerWrapper,
  type HandlerWrapperOptions,
} from './handlers/handler-wrapper.js';

export { CqrsTransactionalBootstrap } from './handlers/bootstrap.js';

export {
  TransactionalEventBusPublisher,
  type TransactionalEventBusPublisherDependencies,
} from './event-publisher/transactional-event-bus-publisher.js';
export { CqrsEventBusBinding } from './event-publisher/event-bus-binding.js';
export {
  OUTBOX_PUBLICATION_SCHEDULER,
  type OutboxPublicationScheduler,
} from './event-publisher/outbox-publication-scheduler.js';

export {
  CQRS_TRANSACTIONAL_OPTIONS,
  CqrsTransactionalModule,
  type CqrsTransactionalAsyncFactoryResult,
  type CqrsTransactionalAsyncOptions,
  type CqrsTransactionalOptions,
} from './module/cqrs-transactional.module.js';
