import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { PropagationMode, TransactionManager } from '@nestjs-transactional/core';

import {
  deriveListenerId,
  getOutboxEventListenerMetadata,
  type OutboxEventListenerMetadata,
} from '../decorators/outbox-event-listener.decorator';

import { OutboxListenerRegistry } from './listener-registry';

type OutboxListenerMethod = (event: unknown) => Promise<void>;

/**
 * Bootstrap-time scanner that walks every provider in the running Nest
 * application, finds methods decorated with `@OutboxEventListener`, and
 * registers them with {@link OutboxListenerRegistry}.
 *
 * Each registered entry carries a pre-bound `invoke` closure that
 * applies `REQUIRES_NEW` transaction semantics when
 * `newTransaction: true` (the default, matching Spring Modulith's
 * `@ApplicationModuleListener`) and invokes the method directly
 * otherwise.
 *
 * Registration runs in `onModuleInit` so all providers have been
 * instantiated by the time the scan happens. Providers with no
 * instance / metatype are skipped silently.
 */
@Injectable()
export class OutboxListenerScanner implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly registry: OutboxListenerRegistry,
    private readonly transactionManager: TransactionManager,
  ) {}

  onModuleInit(): void {
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

        const metadata = getOutboxEventListenerMetadata(method);
        if (metadata === undefined) {
          continue;
        }

        this.registerListener(instance, methodName, metadata);
      }
    }
  }

  private registerListener(
    instance: object,
    methodName: string,
    metadata: OutboxEventListenerMetadata,
  ): void {
    const className = instance.constructor.name;
    const id = metadata.id ?? deriveListenerId(className, methodName);
    const eventType = metadata.eventType.name;

    const rawMethod = (instance as Record<string, unknown>)[methodName] as OutboxListenerMethod;
    const boundMethod: OutboxListenerMethod = rawMethod.bind(instance);
    const manager = this.transactionManager;
    const { newTransaction } = metadata;

    const invoke = async (event: unknown): Promise<void> => {
      if (newTransaction) {
        await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
          await boundMethod(event);
        });
      } else {
        await boundMethod(event);
      }
    };

    this.registry.register({ id, eventType, invoke });
  }
}
