import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

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

import { OutboxListenerRegistry } from './listener-registry';

/**
 * Cross-package shared DI token for the outbox listener registrar
 * structural port (declared in the cqrs package as
 * `OUTBOX_LISTENER_REGISTRAR`). Defined here via `Symbol.for(...)`
 * with the same key the cqrs package uses, so both packages refer
 * to the same Symbol identity without a direct import in either
 * direction (Convention #8 — same pattern as `WRAPPED_MARKER`).
 *
 * Importing this constant from `@nestjs-transactional/outbox` and
 * importing `OUTBOX_LISTENER_REGISTRAR` from `@nestjs-transactional/cqrs`
 * yields the same Symbol — they are interchangeable in `@Inject(...)`
 * arguments.
 *
 * @internal — used by `OutboxModule.forRoot` to auto-bind the smart
 * registrar. Consumers should keep importing
 * `OUTBOX_LISTENER_REGISTRAR` from `@nestjs-transactional/cqrs` for
 * source-level clarity.
 */
export const OUTBOX_LISTENER_REGISTRAR_TOKEN = Symbol.for(
  '@nestjs-transactional/cqrs/outbox-listener-registrar',
);

/** Shape of an entry registered through the structural registrar port. */
interface RegistrarListenerEntry {
  readonly id: string;
  readonly eventType: string;
  readonly invoke: (event: unknown) => Promise<void>;
}

/**
 * Multi-dataSource implementation of the cqrs package's
 * `OutboxListenerRegistrar` structural port (Phase 14.3.1).
 *
 * Walks every per-dataSource {@link EventTypeRegistry} to resolve
 * which dataSource owns each incoming listener's event class, then
 * registers the listener with that dataSource's
 * {@link OutboxListenerRegistry}. The cqrs scanner
 * (`IntegrationEventsHandlerScanner`) injects the structural port
 * blindly — this class is what makes a single inject-point handle
 * arbitrary multi-DS deployments.
 *
 * **Auto-binding.** `OutboxModule.forRoot` registers this class
 * under {@link OUTBOX_LISTENER_REGISTRAR_TOKEN} on the first
 * `forRoot` call. The cqrs `IntegrationEventsHandlerScanner` then
 * picks it up via its `@Optional() @Inject(OUTBOX_LISTENER_REGISTRAR)`
 * — no consumer-side wiring required.
 *
 * **Failure modes** (delegated to {@link resolveDataSourceByEventTypeName}):
 *
 *  - Event not registered in any dataSource → throws on registration.
 *  - Event registered in more than one dataSource → throws on
 *    registration.
 *
 * In both cases the `IntegrationEventsHandlerScanner` propagates the
 * error from its `onModuleInit`, surfacing the misconfiguration at
 * application bootstrap rather than at first dispatch.
 */
@Injectable()
export class MultiDsOutboxListenerRegistrar {
  private readonly logger = new Logger(MultiDsOutboxListenerRegistrar.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(OUTBOX_DATA_SOURCE_NAMES)
    private readonly dataSourceNames: OutboxDataSourceNames,
  ) {}

  /**
   * Register a listener with the per-dataSource
   * {@link OutboxListenerRegistry} whose dataSource owns
   * `listener.eventType`. Throws when the event-type cannot be
   * routed unambiguously — see {@link resolveDataSourceByEventTypeName}.
   */
  register(listener: RegistrarListenerEntry): void {
    const eventTypeRegistries = this.collectEventTypeRegistries();
    const dataSource = resolveDataSourceByEventTypeName(
      listener.eventType,
      eventTypeRegistries,
    );

    const registry = this.moduleRef.get<OutboxListenerRegistry>(
      getOutboxListenerRegistryToken(dataSource),
      { strict: false },
    );
    registry.register(listener);

    this.logger.debug(
      `Routed listener id='${listener.id}' for event '${listener.eventType}' → dataSource '${dataSource}'`,
    );
  }

  /**
   * Collect a Map of dataSource name → {@link EventTypeRegistry}
   * from the live registrations Set. Resolved fresh per `register`
   * call so a registrar surviving across module rebuilds (test
   * scenarios) sees the current state instead of a snapshot taken
   * at construction time.
   */
  private collectEventTypeRegistries(): Map<string, EventTypeRegistry> {
    const registries = new Map<string, EventTypeRegistry>();
    for (const dataSource of this.dataSourceNames.keys()) {
      const registry = this.moduleRef.get<EventTypeRegistry>(
        getEventTypeRegistryToken(dataSource),
        { strict: false },
      );
      registries.set(dataSource, registry);
    }
    return registries;
  }
}
