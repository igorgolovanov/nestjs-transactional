import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
  type Type,
} from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { PropagationMode, TransactionManager } from '@nestjs-transactional/core';

import {
  type IntegrationEventsHandlerMetadata,
  getIntegrationEventsHandlerMetadata,
} from '../decorators/integration-events-handler.decorator';
import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';
import { TransactionPhase } from '../types/transactional-listener.types';

import {
  OUTBOX_LISTENER_REGISTRAR,
  type OutboxListenerRegistrar,
} from './outbox-listener-registrar';

type HandlerMethod = (event: unknown) => unknown;

/**
 * Bootstrap-time scanner for `@IntegrationEventsHandler`-annotated
 * classes. Decides at startup which delivery path to wire based on
 * whether an {@link OutboxListenerRegistrar} is bound:
 *
 * - **Outbox bound** (typically via `OutboxModule` from
 *   `@nestjs-transactional/outbox`): the handler's `handle`
 *   method is registered with the outbox registry, wrapped in a
 *   `REQUIRES_NEW` transaction. Delivery is durable, at-least-once,
 *   retried on failure, survives restarts.
 *
 * - **Outbox not bound**: the handler is registered with
 *   {@link TransactionalEventDispatcher} for `AFTER_COMMIT` phase,
 *   `async: true` — and the scanner itself wraps the invocation in a
 *   fresh transaction so downstream writes commit or roll back
 *   independently, matching the outbox path as closely as in-memory
 *   dispatch allows (minus persistence).
 *
 * Consumer code is identical either way; only module wiring decides.
 */
@Injectable()
export class IntegrationEventsHandlerScanner implements OnModuleInit {
  private readonly logger = new Logger(IntegrationEventsHandlerScanner.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly dispatcher: TransactionalEventDispatcher,
    private readonly manager: TransactionManager,
    @Optional()
    @Inject(OUTBOX_LISTENER_REGISTRAR)
    private readonly registrar?: OutboxListenerRegistrar,
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

      if (this.registrar !== undefined) {
        this.registerToOutbox(instance, metadata, boundHandle, this.registrar);
      } else {
        this.registerToDispatcher(instance, metadata, boundHandle);
      }
    }
  }

  private registerToOutbox(
    instance: object,
    metadata: IntegrationEventsHandlerMetadata,
    boundHandle: HandlerMethod,
    registrar: OutboxListenerRegistrar,
  ): void {
    const manager = this.manager;
    const invoke = async (event: unknown): Promise<void> => {
      await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
        await boundHandle(event);
      });
    };

    const baseId = metadata.id ?? instance.constructor.name;

    for (const eventType of metadata.eventTypes) {
      const listenerId = composeListenerId(baseId, eventType);
      registrar.register({
        id: listenerId,
        eventType: eventType.name,
        invoke,
      });
      this.logger.debug(
        `Registered ${instance.constructor.name}.handle for ${eventType.name} via outbox (id=${listenerId})`,
      );
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
    // invocation — AFTER_COMMIT + async + a new tx, matching the
    // outbox semantics as closely as in-memory dispatch permits.
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

/**
 * Compose the stable listener id. Always ends with `#${EventName}`
 * so a single class handling multiple event types gets distinct ids
 * — the registry requires globally-unique ids.
 */
function composeListenerId(baseId: string, eventType: Type): string {
  return `${baseId}#${eventType.name}`;
}
