import { OutboxError } from '../types/errors';

import type { EventTypeRegistry } from './event-type-registry';

/**
 * Resolve the dataSource that owns a given event-type name by walking
 * a Map of per-dataSource {@link EventTypeRegistry} instances. Returns
 * the dataSource name as a string when exactly one registry contains
 * the event-type — otherwise throws {@link OutboxError} with an
 * actionable message.
 *
 * Single source of truth shared by three consumers (Phase 14.3.1):
 *
 *  - {@link OutboxEventPublisher.resolveDataSource} — smart-facade
 *    publisher routes events to the dataSource that registered them.
 *  - `OutboxListenerScanner` — decorator-driven `@OutboxEventsHandler`
 *    handlers register with the per-dataSource
 *    `OutboxListenerRegistry` whose dataSource owns the event class.
 *  - `MultiDsOutboxListenerRegistrar` — bridges
 *    `@IntegrationEventsHandler` from the cqrs package's structural
 *    port to the per-dataSource registry.
 *
 * Failure modes:
 *
 *  - **Zero matches** (event not registered anywhere): the caller is
 *    almost always missing an `OutboxModule.forFeature([X], { dataSource })`
 *    call. The thrown message names the event and suggests the fix.
 *  - **Multiple matches** (event registered in more than one dataSource):
 *    ambiguous routing. The thrown message names the event, lists the
 *    candidate dataSources, and suggests either restricting the
 *    registration to one dataSource or using an explicit
 *    `{ dataSource }` option (in publisher contexts) / programmatic
 *    per-DS listener registration (in scanner contexts).
 *
 * The same throw policy is applied across all three consumers so the
 * mental model is uniform: an event class belongs to exactly one
 * dataSource by registration.
 *
 * @param eventTypeName The event class's `constructor.name`.
 * @param registries Map of dataSource name → {@link EventTypeRegistry}.
 * @returns The dataSource name.
 * @throws {OutboxError} when zero or multiple registries contain the
 *   event-type.
 */
export function resolveDataSourceByEventTypeName(
  eventTypeName: string,
  registries: ReadonlyMap<string, EventTypeRegistry>,
): string {
  const matches: string[] = [];
  for (const [dataSource, registry] of registries) {
    if (registry.has(eventTypeName)) {
      matches.push(dataSource);
    }
  }

  if (matches.length === 0) {
    throw new OutboxError(
      `Event type '${eventTypeName}' is not registered in any dataSource. ` +
        `Add it to OutboxModule.forFeature([...], { dataSource: '...' }) ` +
        `in the feature module that owns the event class.`,
    );
  }
  if (matches.length > 1) {
    throw new OutboxError(
      `Event type '${eventTypeName}' is registered in multiple dataSources ` +
        `(${matches.join(', ')}). Pass an explicit { dataSource } option to ` +
        `disambiguate, or register the event in only one dataSource.`,
    );
  }
  // Exactly one match — narrow safe.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return matches[0]!;
}
