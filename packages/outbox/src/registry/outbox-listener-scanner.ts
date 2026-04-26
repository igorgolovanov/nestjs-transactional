import { Injectable, Logger, type OnModuleInit, type Type } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { PropagationMode, TransactionManager } from '@nestjs-transactional/core';

import { getOutboxEventsHandlerMetadata } from '../decorators/outbox-events-handler.decorator';

import { OutboxListenerRegistry } from './listener-registry';

type OutboxListenerMethod = (event: unknown) => Promise<void>;

/**
 * Bootstrap-time scanner that walks every provider in the running
 * Nest application, finds classes decorated with
 * `@OutboxEventsHandler`, and registers their `handle` method with
 * {@link OutboxListenerRegistry} — one registration per event type
 * listed in the decorator metadata.
 *
 * Scanning is class-level only. The handler class must expose a
 * `handle(event): Promise<void>` method (enforce this at the type
 * level by implementing `IOutboxEventsHandler`).
 *
 * Each registered entry carries a pre-bound `invoke` closure that
 * applies `REQUIRES_NEW` transaction semantics when
 * `newTransaction: true` (the default) and invokes the method
 * directly otherwise.
 *
 * Registration runs in `onModuleInit` so all providers have been
 * instantiated by the time the scan happens.
 */
@Injectable()
export class OutboxListenerScanner implements OnModuleInit {
  private readonly logger = new Logger(OutboxListenerScanner.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly registry: OutboxListenerRegistry,
    private readonly transactionManager: TransactionManager,
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

      const metadata = getOutboxEventsHandlerMetadata(wrapper.metatype);
      if (metadata === undefined) {
        continue;
      }

      const instance: object = wrapper.instance as object;
      const rawHandle = (instance as Record<string, unknown>).handle;
      if (typeof rawHandle !== 'function') {
        const className = (wrapper.metatype as { name?: string }).name ?? 'anonymous';
        this.logger.warn(
          `@OutboxEventsHandler on ${className}: missing \`handle(event)\` method — skipping`,
        );
        continue;
      }

      const boundHandle = (rawHandle as OutboxListenerMethod).bind(instance);
      const manager = this.transactionManager;
      const { newTransaction } = metadata;

      const invoke = async (event: unknown): Promise<void> => {
        if (newTransaction) {
          await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
            await boundHandle(event);
          });
        } else {
          await boundHandle(event);
        }
      };

      const baseId = metadata.id ?? instance.constructor.name;

      for (const eventType of metadata.eventTypes) {
        const listenerId = composeListenerId(baseId, eventType);
        this.registry.register({
          id: listenerId,
          eventType: eventType.name,
          invoke,
        });
      }
    }
  }
}

/**
 * Compose the stable listener id. Always ends with `#${EventName}`
 * so a single class handling multiple event types gets distinct ids
 * — the registry requires globally-unique ids. Exported so consumers
 * can pre-compute the id for explicit registration / tests.
 */
export function composeListenerId(baseId: string, eventType: Type): string {
  return `${baseId}#${eventType.name}`;
}
