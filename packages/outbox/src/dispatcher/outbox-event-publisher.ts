import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { EventTypeRegistry } from '../serialization/event-type-registry';
import {
  getEventTypeRegistryToken,
  getOutboxPublisherToken,
} from '../tokens/token-utils';
import { OutboxError } from '../types/errors';

import { DataSourceOutboxPublisher } from './data-source-outbox-publisher';

/**
 * Optional override accepted by the facade `OutboxEventPublisher`'s
 * publish methods to target a specific dataSource explicitly.
 *
 * When omitted, the facade routes by event-type registration: the
 * event class is looked up in each per-dataSource
 * {@link EventTypeRegistry}, and the dataSource that registered it
 * owns the publication.
 */
export interface OutboxPublishOptions {
  /**
   * Public dataSource name to publish to. Always wins over event-type
   * routing when set. Useful for events that are registered in
   * multiple dataSources, or for explicit cross-dataSource routing.
   */
  readonly dataSource?: string;
}

/**
 * High-level smart-facade publisher (DD-024). The single user-facing
 * publisher class — application code injects `OutboxEventPublisher`
 * and the facade routes publications to the per-dataSource
 * {@link DataSourceOutboxPublisher} that owns the event class.
 *
 * **Routing algorithm** (in order):
 *  1. If `options.dataSource` is provided, route to that dataSource.
 *  2. Else, look up `event.constructor.name` in each registered
 *     per-dataSource {@link EventTypeRegistry}; the registry that
 *     contains the event determines the destination.
 *  3. If no registry contains the event, throw {@link OutboxError}.
 *
 * **Cross-dataSource publishing** is allowed: the routing decision is
 * about the event's *registered* dataSource, NOT about which
 * transactions are currently active. With Phase 14.2's cross-DS
 * simultaneous transactions, a billing event published from inside an
 * outer-billing / inner-inventory async stack still routes to billing
 * (because that's where the event class is registered) and validates
 * its atomicity against the billing transaction.
 *
 * **Single-dataSource deployments** see no behavioural change: there
 * is one per-DS publisher (named `'default'`), one event-type
 * registry, and the facade transparently delegates to it.
 *
 * Replaces the pre-Phase-14.3 publisher whose internal
 * `findCurrentTransaction()` returned an arbitrary first-active
 * transaction — non-deterministic with multiple active transactions.
 * No backwards-compatibility shim: callers always inject
 * `OutboxEventPublisher` and receive routing semantics consistent
 * with the registered event-type ownership.
 */
/** @internal — DI token carrying the live Map of registered dataSources. */
export const OUTBOX_DATA_SOURCE_NAMES = Symbol('OUTBOX_DATA_SOURCE_NAMES');

/** @internal — Read-only view of the shared registration list. */
export type OutboxDataSourceNames = ReadonlySet<string> | { keys(): IterableIterator<string> };

@Injectable()
export class OutboxEventPublisher implements OnModuleInit {
  private readonly logger = new Logger(OutboxEventPublisher.name);
  private readonly publishers = new Map<string, DataSourceOutboxPublisher>();
  private readonly eventTypeRegistries = new Map<string, EventTypeRegistry>();

  constructor(
    private readonly moduleRef: ModuleRef,
    /**
     * Live reference to {@link OutboxModule.registrations} (passed via
     * `useValue` so its `keys()` enumeration sees every dataSource
     * registered across all `forRoot` calls — `useValue` captures the
     * Map by reference, so later forRoot pushes are visible at
     * `OnModuleInit` time).
     */
    @Inject(OUTBOX_DATA_SOURCE_NAMES)
    private readonly dataSourceNames: OutboxDataSourceNames,
  ) {}

  /**
   * Late-bind per-DS publishers and event-type registries via
   * `ModuleRef`. Lifecycle hook chosen because it fires AFTER every
   * provider has been instantiated — by then every per-DS publisher
   * exists and is resolvable, regardless of the order in which the
   * facade's `forRoot` and per-DS `forRoot`s appear in the import
   * tree.
   */
  onModuleInit(): void {
    for (const ds of this.dataSourceNames.keys()) {
      this.publishers.set(
        ds,
        this.moduleRef.get<DataSourceOutboxPublisher>(getOutboxPublisherToken(ds), {
          strict: false,
        }),
      );
      this.eventTypeRegistries.set(
        ds,
        this.moduleRef.get<EventTypeRegistry>(getEventTypeRegistryToken(ds), {
          strict: false,
        }),
      );
    }
  }

  /**
   * Publish a single event. Routing per the class JSDoc:
   * `options.dataSource` (explicit) > event-type registration
   * (implicit) > {@link OutboxError}.
   *
   * Must be called inside an active transaction *for the resolved
   * dataSource* — `DataSourceOutboxPublisher.publish` enforces this
   * with a clear error message naming the dataSource.
   */
  async publish(event: unknown, options: OutboxPublishOptions = {}): Promise<void> {
    const dataSource = this.resolveDataSource(event, options);
    const publisher = this.requirePublisher(dataSource);
    await publisher.publish(event);
  }

  /**
   * Publish a batch of events. Each event is routed independently, so
   * a mixed-dataSource batch (e.g. one billing event and one
   * inventory event in the same call) routes each to its own
   * dataSource publisher.
   */
  async publishAll(events: readonly unknown[], options: OutboxPublishOptions = {}): Promise<void> {
    for (const event of events) {
      await this.publish(event, options);
    }
  }

  /**
   * Synchronous scheduling sibling of {@link publish}. Designed for
   * sync callers such as `@nestjs/cqrs`'s `AggregateRoot.commit()`
   * pathway. Same routing rules apply.
   *
   * Inside the resolved dataSource's active transaction: events are
   * buffered and flushed in a `beforeCommit` hook
   * (see {@link DataSourceOutboxPublisher.scheduleForPublication}).
   * Outside any transaction: fire-and-forget {@link publish}, errors
   * logged because there is no caller to propagate to.
   *
   * If the event cannot be routed (no matching registration), the
   * call is logged-and-dropped — sync paths cannot raise.
   */
  scheduleForPublication(event: unknown, options: OutboxPublishOptions = {}): void {
    let dataSource: string;
    try {
      dataSource = this.resolveDataSource(event, options);
    } catch (err) {
      this.logger.error(
        `scheduleForPublication: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const publisher = this.publishers.get(dataSource);
    if (publisher === undefined) {
      this.logger.error(
        `scheduleForPublication: no outbox publisher registered for dataSource '${dataSource}'`,
      );
      return;
    }
    publisher.scheduleForPublication(event);
  }

  /**
   * Read-only snapshot of the dataSources this facade routes to.
   * Useful for diagnostics and tests.
   */
  getRegisteredDataSources(): readonly string[] {
    return Array.from(this.publishers.keys());
  }

  private resolveDataSource(event: unknown, options: OutboxPublishOptions): string {
    if (options.dataSource !== undefined) {
      return options.dataSource;
    }

    const eventType = (event as object).constructor.name;
    const matches: string[] = [];
    for (const [dataSource, registry] of this.eventTypeRegistries) {
      if (registry.has(eventType)) {
        matches.push(dataSource);
      }
    }

    if (matches.length === 0) {
      throw new OutboxError(
        `Event type '${eventType}' is not registered in any dataSource. ` +
          `Add it to OutboxModule.forFeature([...], { dataSource: '...' }) ` +
          `in the feature module that owns the event class.`,
      );
    }
    if (matches.length > 1) {
      throw new OutboxError(
        `Event type '${eventType}' is registered in multiple dataSources ` +
          `(${matches.join(', ')}). Pass an explicit { dataSource } option to ` +
          `disambiguate, or register the event in only one dataSource.`,
      );
    }
    // Length is exactly 1 here (checked above); narrowing safe.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return matches[0]!;
  }

  private requirePublisher(dataSource: string): DataSourceOutboxPublisher {
    const publisher = this.publishers.get(dataSource);
    if (publisher === undefined) {
      throw new OutboxError(
        `No outbox configured for dataSource '${dataSource}'. ` +
          `Add 'OutboxModule.forRoot({ dataSource: '${dataSource}' })' to the module imports.`,
      );
    }
    return publisher;
  }
}
