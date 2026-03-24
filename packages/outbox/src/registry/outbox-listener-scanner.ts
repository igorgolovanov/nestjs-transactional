import { Inject, Injectable, Logger, type OnModuleInit, type Type } from '@nestjs/common';
import { DiscoveryService, ModuleRef } from '@nestjs/core';
import { PropagationMode, TransactionManager } from '@nestjs-transactional/core';

import { getOutboxEventsHandlerMetadata } from '../decorators/outbox-events-handler.decorator';
import {
  OUTBOX_DATA_SOURCE_NAMES,
  type OutboxDataSourceNames,
} from '../dispatcher/outbox-event-publisher';
import { EventTypeRegistry } from '../serialization/event-type-registry';
import { resolveDataSourceByEventTypeName } from '../serialization/event-type-resolver';
import {
  getEventTypeRegistryToken,
  getOutboxListenerRegistryToken,
} from '../tokens/token-utils';
import { OutboxError } from '../types/errors';

import { OutboxListenerRegistry } from './listener-registry';

type OutboxListenerMethod = (event: unknown) => Promise<void>;

/**
 * Bootstrap-time scanner that walks every provider in the running
 * Nest application, finds classes decorated with
 * `@OutboxEventsHandler`, and registers their `handle` method with
 * the per-dataSource {@link OutboxListenerRegistry} that owns each
 * decorated event class.
 *
 * **Per-dataSource routing (Phase 14.3.1).** Multi-`OutboxModule.forRoot`
 * deployments register events to per-DS `EventTypeRegistry`
 * instances via `OutboxModule.forFeature(events, { dataSource })`.
 * The scanner walks every per-DS `EventTypeRegistry`, resolves which
 * dataSource owns each handler's event classes (via
 * {@link resolveDataSourceByEventTypeName}), and registers the
 * handler with the matching per-DS `OutboxListenerRegistry`.
 *
 * Single-dataSource deployments see the same behaviour they always
 * have: events go to the only registry, handlers register against it.
 *
 * **Constraint: handler events must come from a single dataSource.**
 * A handler subscribing to events spanning multiple dataSources is a
 * configuration error — handlers conceptually belong to one
 * bounded context. The scanner throws at bootstrap with an
 * actionable message naming the offending events and dataSources.
 *
 * Scanning is class-level only. The handler class must expose a
 * `handle(event): Promise<void>` method (enforce this at the type
 * level by implementing `IOutboxEventHandler`).
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
    private readonly moduleRef: ModuleRef,
    @Inject(OUTBOX_DATA_SOURCE_NAMES)
    private readonly dataSourceNames: OutboxDataSourceNames,
    private readonly transactionManager: TransactionManager,
  ) {}

  onModuleInit(): void {
    const eventTypeRegistries = this.collectEventTypeRegistries();
    const listenerRegistries = this.collectListenerRegistries();

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

      const className = (wrapper.metatype as { name?: string }).name ?? 'anonymous';
      const instance: object = wrapper.instance as object;
      const rawHandle = (instance as Record<string, unknown>).handle;
      if (typeof rawHandle !== 'function') {
        this.logger.warn(
          `@OutboxEventsHandler on ${className}: missing \`handle(event)\` method — skipping`,
        );
        continue;
      }

      const dataSource = this.resolveHandlerDataSource(
        className,
        metadata.eventTypes,
        eventTypeRegistries,
      );
      const registry = listenerRegistries.get(dataSource);
      if (registry === undefined) {
        // Defensive — every dataSource in `dataSourceNames` is also
        // in `listenerRegistries` because both maps are built from
        // the same Set. Throw rather than silently skip.
        throw new OutboxError(
          `@OutboxEventsHandler on ${className}: no OutboxListenerRegistry registered for ` +
            `dataSource '${dataSource}'. This is a framework bug — please open an issue.`,
        );
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
        registry.register({
          id: listenerId,
          eventType: eventType.name,
          invoke,
        });
      }
    }
  }

  /**
   * Resolve which dataSource a handler belongs to by looking up each
   * of its decorated events in the per-DS event-type registries. The
   * handler's events must all resolve to the same dataSource —
   * cross-DS handlers are rejected at bootstrap.
   */
  private resolveHandlerDataSource(
    className: string,
    eventTypes: readonly Type[],
    eventTypeRegistries: ReadonlyMap<string, EventTypeRegistry>,
  ): string {
    const dataSourcePerEvent = new Map<string, string>();
    for (const eventType of eventTypes) {
      const dataSource = resolveDataSourceByEventTypeName(
        eventType.name,
        eventTypeRegistries,
      );
      dataSourcePerEvent.set(eventType.name, dataSource);
    }

    const uniqueDataSources = new Set(dataSourcePerEvent.values());
    if (uniqueDataSources.size > 1) {
      const breakdown = [...dataSourcePerEvent]
        .map(([eventName, dataSource]) => `  ${eventName} → '${dataSource}'`)
        .join('\n');
      throw new OutboxError(
        `@OutboxEventsHandler on ${className}: events span multiple dataSources:\n${breakdown}\n` +
          `Handlers must be scoped to a single dataSource. Either:\n` +
          `  • register the events under the same dataSource (OutboxModule.forFeature(...))\n` +
          `  • split the handler into separate classes per dataSource\n` +
          `  • register manually via getOutboxListenerRegistryToken(ds).register(...)`,
      );
    }
    // Exactly one entry — uniqueDataSources is non-empty because
    // metadata.eventTypes is enforced non-empty by the decorator.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return [...uniqueDataSources][0]!;
  }

  private collectEventTypeRegistries(): Map<string, EventTypeRegistry> {
    const registries = new Map<string, EventTypeRegistry>();
    for (const dataSource of this.dataSourceNames.keys()) {
      registries.set(
        dataSource,
        this.moduleRef.get<EventTypeRegistry>(getEventTypeRegistryToken(dataSource), {
          strict: false,
        }),
      );
    }
    return registries;
  }

  private collectListenerRegistries(): Map<string, OutboxListenerRegistry> {
    const registries = new Map<string, OutboxListenerRegistry>();
    for (const dataSource of this.dataSourceNames.keys()) {
      registries.set(
        dataSource,
        this.moduleRef.get<OutboxListenerRegistry>(getOutboxListenerRegistryToken(dataSource), {
          strict: false,
        }),
      );
    }
    return registries;
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
