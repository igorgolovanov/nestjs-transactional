import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import { getTransactionalEventsHandlerMetadata } from '../decorators/transactional-events-handler.decorator';
import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';

/**
 * Bootstrap-time scanner that walks every provider in the running
 * Nest application, finds every class decorated with
 * `@TransactionalEventsHandler`, and registers its `handle` method
 * with the {@link TransactionalEventDispatcher} — one registration
 * per event type listed in the decorator metadata.
 *
 * Scanning is class-level only. The handler class must expose a
 * `handle(event): void | Promise<void>` method (enforce this at the
 * type level by implementing `ITransactionalEventHandler`).
 *
 * `@IntegrationEventsHandler` is NOT processed here —
 * `IntegrationEventsHandlerScanner` owns it, with smart routing to
 * the outbox or this dispatcher depending on which provider is bound.
 *
 * Registration happens in `onModuleInit` so all providers have been
 * instantiated by the time the scan runs. Providers with no instance
 * or no metatype are skipped silently.
 *
 * Wired into the application by `CqrsTransactionalModule`. Not
 * exported for direct consumer instantiation.
 */
@Injectable()
export class TransactionalListenerScanner implements OnModuleInit {
  private readonly logger = new Logger(TransactionalListenerScanner.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly dispatcher: TransactionalEventDispatcher,
  ) {}

  onModuleInit(): void {
    const providers = this.discovery.getProviders();

    for (const wrapper of providers) {
      if (
        wrapper.metatype === null ||
        typeof wrapper.metatype !== 'function' ||
        wrapper.instance === null ||
        wrapper.instance === undefined
      ) {
        continue;
      }

      const metadata = getTransactionalEventsHandlerMetadata(wrapper.metatype);
      if (metadata === undefined) {
        continue;
      }

      const instance: object = wrapper.instance as object;
      const handleMethod = (instance as Record<string, unknown>).handle;
      if (typeof handleMethod !== 'function') {
        const className = (wrapper.metatype as { name?: string }).name ?? 'anonymous';
        this.logger.warn(
          `@TransactionalEventsHandler on ${className}: missing \`handle(event)\` method — skipping`,
        );
        continue;
      }

      for (const eventType of metadata.eventTypes) {
        this.dispatcher.registerListener(instance, 'handle', {
          eventType,
          phase: metadata.phase,
          async: metadata.async,
          fallbackExecution: metadata.fallbackExecution,
        });
      }
    }
  }
}
