import { DEFAULT_DATA_SOURCE_NAME } from '@nestjs-transactional/core';

/**
 * Outbox-side token utilities. Mirror the core utilities (ADR-018) —
 * deterministic DI tokens derived from a dataSource name, default
 * `'default'`, format `${dataSource}${Component}`.
 *
 * One per outbox component the application can have a per-dataSource
 * instance of: publisher, registries, processor, repository,
 * externalizer, serializer. Per-dataSource scoping is what lets a
 * modular monolith run separate outbox stacks per bounded context
 * without contention on a single `event_publication` table.
 */

/**
 * DI token for the per-dataSource `OutboxEventPublisher`. The
 * default-injected publisher is the smart facade (DD-024); this
 * token resolves to the underlying per-dataSource publisher.
 */
export function getOutboxPublisherToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}OutboxEventPublisher`;
}

/**
 * DI token for the per-dataSource `EventTypeRegistry`. Event-type
 * registrations from `OutboxModule.forFeature(...)` accumulate into
 * the registry bound to the same dataSource — they do not bleed
 * across dataSources.
 */
export function getEventTypeRegistryToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}EventTypeRegistry`;
}

/**
 * DI token for the per-dataSource `EventPublicationRegistry` — the
 * lifecycle coordinator that owns publication state transitions.
 */
export function getEventPublicationRegistryToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}EventPublicationRegistry`;
}

/**
 * DI token for the per-dataSource `EventPublicationProcessor` —
 * the async worker that drains publications and dispatches them to
 * listeners + externalizer.
 */
export function getEventPublicationProcessorToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}EventPublicationProcessor`;
}

/**
 * DI token for the per-dataSource `OutboxListenerRegistry` —
 * registry of listener entries scanned from `@OutboxEventsHandler`
 * classes (and, when wired, `@IntegrationEventsHandler` classes
 * routed via the outbox).
 */
export function getOutboxListenerRegistryToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}OutboxListenerRegistry`;
}

/**
 * DI token for the per-dataSource `ExternalizationRegistry`.
 */
export function getExternalizationRegistryToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}ExternalizationRegistry`;
}

/**
 * DI token for the per-dataSource `EventPublicationRepository`.
 * Adapter packages (`outbox-typeorm`, future `outbox-prisma`, etc.)
 * register their concrete repository under this token.
 */
export function getEventPublicationRepositoryToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}EventPublicationRepository`;
}

/**
 * DI token for the per-dataSource `EventExternalizer`. Multi-adapter
 * processes can wire externalization independently per outbox stack
 * — e.g. the `'billing'` outbox emits to Kafka, the `'audit'` outbox
 * is internal-only and binds no externalizer.
 */
export function getEventExternalizerToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}EventExternalizer`;
}

/**
 * DI token for the per-dataSource `EventSerializer`. Distinct
 * dataSources may use distinct serialization strategies (e.g.
 * one JSON, another schema-validated) — the token-per-dataSource
 * pattern keeps that pluggable without forcing one strategy
 * process-wide.
 */
export function getOutboxEventSerializerToken(
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): string {
  return `${dataSource}OutboxEventSerializer`;
}
