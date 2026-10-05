import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { TransactionManager } from '@nestjs-transactional/core';

import {
  type IntegrationEventsHandlerMetadata,
  getIntegrationEventsHandlerMetadata,
} from '../decorators/integration-events-handler.decorator.js';
import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher.js';
import { TransactionPhase } from '../types/transactional-listener.types.js';

type HandlerMethod = (event: unknown) => unknown;

/**
 * Bootstrap-time scanner for `@IntegrationEventsHandler`-annotated
 * classes. Registers each handler with {@link TransactionalEventDispatcher}
 * for the `AFTER_COMMIT` phase, `async: true`, and wraps the invocation
 * in a fresh transaction so the handler's own writes commit or roll back
 * independently of the publisher's.
 */
@Injectable()
export class IntegrationEventsHandlerScanner implements OnModuleInit {
  private readonly logger = new Logger(IntegrationEventsHandlerScanner.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly dispatcher: TransactionalEventDispatcher,
    private readonly manager: TransactionManager,
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

      const metadata = getIntegrationEventsHandlerMetadata(wrapper.metatype);
      if (metadata === undefined) {
        continue;
      }

      const instance: object = wrapper.instance as object;
      const rawHandle = (instance as Record<string, unknown>).handle;
      if (typeof rawHandle !== 'function') {
        const className = (wrapper.metatype as { name?: string }).name ?? 'anonymous';
        this.logger.warn(
          `@IntegrationEventsHandler on ${className}: missing \`handle(event)\` method — skipping`,
        );
        continue;
      }

      const boundHandle = (rawHandle as HandlerMethod).bind(instance);

      this.registerToDispatcher(instance, metadata, boundHandle);
    }
  }

  private registerToDispatcher(
    instance: object,
    metadata: IntegrationEventsHandlerMetadata,
    boundHandle: HandlerMethod,
  ): void {
    const manager = this.manager;
    // Proxy preserves the original class name for dispatcher logs
    // while exposing a `handle` that opens a fresh transaction per
    // invocation: AFTER_COMMIT, async, and a new transaction.
    const ctor = instance.constructor as { prototype: object | null };
    const proxy = Object.create(ctor.prototype) as Record<string, unknown>;
    proxy.handle = async (event: unknown): Promise<void> => {
      await manager.run({}, async () => {
        await boundHandle(event);
      });
    };

    for (const eventType of metadata.eventTypes) {
      this.dispatcher.registerListener(proxy, 'handle', {
        eventType,
        phase: TransactionPhase.AFTER_COMMIT,
        async: true,
        fallbackExecution: false,
        dataSource: metadata.dataSource,
      });
    }
  }
}
