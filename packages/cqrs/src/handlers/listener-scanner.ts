import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { hasOutboxListenerMetadata } from '../decorators/application-module-listener.decorator';
import { getTransactionalEventsListenerMetadata } from '../decorators/transactional-events-listener.decorator';
import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';
import {
  OUTBOX_PUBLICATION_SCHEDULER,
  type OutboxPublicationScheduler,
} from '../event-publisher/hybrid-event-publisher';

/**
 * Bootstrap-time scanner that walks every provider in the running Nest
 * application, finds every method decorated with
 * `@TransactionalEventsListener`, and registers it with the
 * {@link TransactionalEventDispatcher}.
 *
 * Outbox integration: when `OUTBOX_PUBLICATION_SCHEDULER` is bound AND
 * a scanned method also carries outbox listener metadata (from
 * `@OutboxEventListener` or the outbox half of
 * `@ApplicationModuleListener`), the in-memory registration is
 * skipped. The outbox's own scanner picks those methods up, so they
 * run exactly once through the durable path. Without the outbox
 * scheduler bound, methods with outbox metadata still get registered
 * in-memory — the `@ApplicationModuleListener` fallback semantics.
 *
 * Registration happens in `onModuleInit` so all providers have been
 * instantiated by the time the scan runs. Providers with no instance or
 * no metatype (e.g. value providers that Nest has not yet materialised)
 * are skipped silently.
 *
 * Wired into the application by `CqrsTransactionalModule`. Not exported
 * for direct consumer instantiation.
 */
@Injectable()
export class TransactionalListenerScanner implements OnModuleInit {
  private readonly logger = new Logger(TransactionalListenerScanner.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly dispatcher: TransactionalEventDispatcher,
    @Optional()
    @Inject(OUTBOX_PUBLICATION_SCHEDULER)
    private readonly outboxScheduler?: OutboxPublicationScheduler,
  ) {}

  onModuleInit(): void {
    const outboxAvailable = this.outboxScheduler !== undefined;
    const providers = this.discovery.getProviders();

    for (const wrapper of providers) {
      if (
        wrapper.metatype === null ||
        wrapper.instance === null ||
        wrapper.instance === undefined
      ) {
        continue;
      }

      const instance: object = wrapper.instance as object;
      const prototype: object | null = Object.getPrototypeOf(instance) as object | null;
      if (prototype === null) {
        continue;
      }

      const methodNames = this.metadataScanner.getAllMethodNames(prototype);
      const methods = prototype as Record<string, unknown>;

      for (const methodName of methodNames) {
        const method = methods[methodName];
        if (typeof method !== 'function') {
          continue;
        }

        const metadata = getTransactionalEventsListenerMetadata(method);
        if (metadata === undefined) {
          continue;
        }

        if (outboxAvailable && hasOutboxListenerMetadata(method)) {
          const ownerName =
            (wrapper.metatype as { name?: string } | null)?.name ?? 'anonymous';
          this.logger.debug(
            `Skipping in-memory registration for ${ownerName}.${methodName} — delivery handled by outbox`,
          );
          continue;
        }

        this.dispatcher.registerListener(instance, methodName, metadata);
      }
    }
  }
}
