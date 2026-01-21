import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import { getTransactionalEventsListenerMetadata } from '../decorators/transactional-events-listener.decorator';
import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';

/**
 * Bootstrap-time scanner that walks every provider in the running Nest
 * application, finds every method decorated with
 * `@TransactionalEventsListener`, and registers it with the
 * {@link TransactionalEventDispatcher}.
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
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly dispatcher: TransactionalEventDispatcher,
  ) {}

  onModuleInit(): void {
    const providers = this.discovery.getProviders();

    for (const wrapper of providers) {
      if (wrapper.metatype === null || wrapper.instance === null || wrapper.instance === undefined) {
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

        this.dispatcher.registerListener(instance, methodName, metadata);
      }
    }
  }
}
