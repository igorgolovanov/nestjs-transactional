import { Inject } from '@nestjs/common';
import { DEFAULT_DATA_SOURCE_NAME } from '@nestjs-transactional/core';

import {
  getEventExternalizerToken,
  getEventPublicationProcessorToken,
  getEventPublicationRegistryToken,
  getEventPublicationRepositoryToken,
  getEventTypeRegistryToken,
  getExternalizationRegistryToken,
  getOutboxEventSerializerToken,
  getOutboxListenerRegistryToken,
  getOutboxPublisherToken,
} from '../tokens/token-utils';

/**
 * Inject decorators for the outbox-side per-dataSource components
 * (DD-022). Each decorator below is sugar over
 * `@Inject(getXxxToken(dataSource))` with a default dataSource of
 * `'default'` — matches the `@InjectRepository(Entity, dataSource?)`
 * ergonomics from `@nestjs/typeorm`.
 *
 * Single-adapter consumers omit the argument; multi-adapter
 * consumers pass the dataSource name they registered with
 * `OutboxModule.forRoot({ dataSource })`.
 */

/**
 * Inject the per-dataSource `OutboxEventPublisher`. The
 * default-injected publisher is the smart facade (DD-024) that
 * detects the active transaction context and routes accordingly;
 * this decorator binds the underlying per-dataSource publisher
 * directly when explicit selection is needed.
 *
 * @example
 * ```ts
 * class BillingService {
 *   constructor(
 *     @InjectOutboxPublisher('billing')
 *     private readonly publisher: OutboxEventPublisher,
 *   ) {}
 * }
 * ```
 */
export const InjectOutboxPublisher = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getOutboxPublisherToken(dataSource));

/**
 * Inject the per-dataSource `EventTypeRegistry`. The registry is
 * populated by the `OutboxModule.forFeature([...])` calls made
 * against the same dataSource — registrations do not bleed across
 * dataSources.
 */
export const InjectEventTypeRegistry = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getEventTypeRegistryToken(dataSource));

/**
 * Inject the per-dataSource `EventPublicationRegistry` — the
 * lifecycle coordinator that owns publication state transitions
 * (`PUBLISHED` → `PROCESSING` → `COMPLETED` / `FAILED`).
 */
export const InjectEventPublicationRegistry = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getEventPublicationRegistryToken(dataSource));

/**
 * Inject the per-dataSource `EventPublicationProcessor` — the async
 * worker that drains publications, dispatches them to listeners,
 * and invokes the externalizer (when bound). Typically only needed
 * by tests that drive the loop manually with `processBatch()`.
 */
export const InjectEventPublicationProcessor = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getEventPublicationProcessorToken(dataSource));

/**
 * Inject the per-dataSource `OutboxListenerRegistry` — registry of
 * listener entries scanned from `@OutboxEventsHandler` classes (and,
 * when wired, `@IntegrationEventsHandler` classes routed via the
 * outbox).
 */
export const InjectOutboxListenerRegistry = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getOutboxListenerRegistryToken(dataSource));

/**
 * Inject the per-dataSource `ExternalizationRegistry` — maps event
 * type names to their `@Externalized` metadata. Consumed by the
 * processor at dispatch time; rarely needed by application code.
 */
export const InjectExternalizationRegistry = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getExternalizationRegistryToken(dataSource));

/**
 * Inject the per-dataSource `EventPublicationRepository`. Adapter
 * packages (`outbox-typeorm`, future `outbox-prisma`, ...) register
 * their concrete repository under this token. Most application
 * code injects the higher-level `OutboxEventPublisher` instead.
 */
export const InjectEventPublicationRepository = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getEventPublicationRepositoryToken(dataSource));

/**
 * Inject the per-dataSource `EventExternalizer`. Multi-adapter
 * processes can wire externalization independently per outbox stack
 * — e.g. the `'billing'` outbox emits to Kafka, the `'audit'` outbox
 * is internal-only and binds no externalizer.
 */
export const InjectEventExternalizer = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getEventExternalizerToken(dataSource));

/**
 * Inject the per-dataSource `EventSerializer` used by the outbox to
 * marshal events into the stored JSON payload and revive them at
 * dispatch time. Distinct dataSources may use distinct
 * serialization strategies (e.g. one JSON, another schema-validated)
 * without forcing one strategy process-wide.
 */
export const InjectOutboxEventSerializer = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getOutboxEventSerializerToken(dataSource));
