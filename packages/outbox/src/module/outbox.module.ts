import {
  type DynamicModule,
  type FactoryProvider,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { CompletedEventPublications } from '../api/completed-event-publications';
import { FailedEventPublications } from '../api/failed-event-publications';
import { IncompleteEventPublications } from '../api/incomplete-event-publications';
import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import { OutboxEventPublisher } from '../dispatcher/outbox-event-publisher';
import {
  DEFAULT_PROCESSOR_OPTIONS,
  type EventPublicationProcessorOptions,
} from '../dispatcher/processor-options';
import {
  EVENT_EXTERNALIZER,
  type EventExternalizer,
} from '../externalization/event-externalizer';
import { ExternalizationRegistry } from '../externalization/externalization-registry';
import { StalenessMonitor } from '../recovery/staleness-monitor';
import {
  OUTBOX_RECOVERY_OPTIONS,
  type OutboxRecoveryOptions,
  StartupRecoveryService,
} from '../recovery/startup-recovery';
import { EventPublicationRegistry } from '../registry/event-publication-registry';
import { OutboxListenerRegistry } from '../registry/listener-registry';
import { OutboxListenerScanner } from '../registry/outbox-listener-scanner';
import {
  EVENT_PUBLICATION_REPOSITORY,
  type EventPublicationRepository,
} from '../repository/event-publication-repository';
import { EVENT_SERIALIZER, type EventSerializer } from '../serialization/event-serializer';
import { EVENT_TYPE_REGISTRY, EventTypeRegistry } from '../serialization/event-type-registry';
import { JsonEventSerializer } from '../serialization/json-event-serializer';
import { InMemoryEventPublicationRepository } from '../testing/in-memory-repository';
import { CompletionMode } from '../types/completion-mode';
import { DEFAULT_STALENESS_CONFIG, type StalenessConfig } from '../types/staleness-config';

/**
 * Synchronous options for {@link OutboxModule.forRoot}. Partial
 * `processor` / `staleness` objects are merged with the corresponding
 * `DEFAULT_*` constants.
 *
 * `serializer` and `repository` accept full Nest `Provider` objects so
 * consumers can plug in backend-specific implementations (TypeORM,
 * Prisma, ...) without this module knowing about them.
 */
export interface OutboxModuleOptions {
  /** Register the module as `@Global()`. Default: `true`. */
  readonly isGlobal?: boolean;
  readonly processor?: Partial<EventPublicationProcessorOptions>;
  readonly staleness?: Partial<StalenessConfig>;
  /** Default: `false` — do not auto-resubmit on startup. */
  readonly republishOnStartup?: boolean;
  /** Default: 1000. */
  readonly startupBatchSize?: number;
  /** Convenience shortcut — also fills `processor.completionMode`. Default: `UPDATE`. */
  readonly completionMode?: CompletionMode;
  /** Event classes pre-registered on `EventTypeRegistry` at bootstrap. */
  readonly eventTypes?: Type<object>[];
  /** Full Provider for the `EVENT_SERIALIZER` token. Defaults to the JSON impl. */
  readonly serializer?: Provider;
  /**
   * Full Provider for the `EVENT_PUBLICATION_REPOSITORY` token. Defaults
   * to `InMemoryEventPublicationRepository` — SUITABLE FOR TESTS ONLY.
   * Production use requires a durable backend (outbox-typeorm, ...).
   */
  readonly repository?: Provider;
}

/**
 * Subset of {@link OutboxModuleOptions} that can be resolved
 * asynchronously. Provider-valued fields (`serializer`, `repository`)
 * are kept as top-level static options in
 * {@link OutboxModuleAsyncOptions} because providers must be known at
 * module-definition time.
 */
export interface OutboxModuleAsyncFactoryResult {
  readonly processor?: Partial<EventPublicationProcessorOptions>;
  readonly staleness?: Partial<StalenessConfig>;
  readonly republishOnStartup?: boolean;
  readonly startupBatchSize?: number;
  readonly completionMode?: CompletionMode;
  readonly eventTypes?: Type<object>[];
}

/**
 * Options for {@link OutboxModule.forRootAsync}. `serializer` and
 * `repository` remain synchronous (see
 * {@link OutboxModuleAsyncFactoryResult}); everything else is
 * resolved via the async `useFactory`.
 */
export interface OutboxModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly isGlobal?: boolean;
  readonly serializer?: Provider;
  readonly repository?: Provider;
  readonly useFactory: (
    ...args: never[]
  ) => Promise<OutboxModuleAsyncFactoryResult> | OutboxModuleAsyncFactoryResult;
  readonly inject?: readonly InjectionToken[];
}

/** DI token carrying the resolved {@link EventPublicationProcessorOptions}. */
export const OUTBOX_PROCESSOR_OPTIONS = Symbol('OUTBOX_PROCESSOR_OPTIONS');
/** DI token carrying the resolved {@link StalenessConfig}. */
export const OUTBOX_STALENESS_CONFIG = Symbol('OUTBOX_STALENESS_CONFIG');

const ASYNC_OPTIONS_TOKEN = Symbol('OUTBOX_ASYNC_OPTIONS');

const EXPORTS: NonNullable<DynamicModule['exports']> = [
  OutboxEventPublisher,
  EventPublicationRegistry,
  OutboxListenerRegistry,
  EVENT_TYPE_REGISTRY,
  EventTypeRegistry,
  EVENT_SERIALIZER,
  EVENT_PUBLICATION_REPOSITORY,
  FailedEventPublications,
  IncompleteEventPublications,
  CompletedEventPublications,
  EventPublicationProcessor,
  StalenessMonitor,
  ExternalizationRegistry,
];

function resolveProcessorOptions(
  processor: Partial<EventPublicationProcessorOptions> | undefined,
  completionMode: CompletionMode | undefined,
): EventPublicationProcessorOptions {
  return {
    ...DEFAULT_PROCESSOR_OPTIONS,
    ...processor,
    completionMode: completionMode ?? processor?.completionMode ?? DEFAULT_PROCESSOR_OPTIONS.completionMode,
  };
}

function resolveStalenessConfig(staleness: Partial<StalenessConfig> | undefined): StalenessConfig {
  return { ...DEFAULT_STALENESS_CONFIG, ...staleness };
}

function resolveRecoveryOptions(
  republishOnStartup: boolean | undefined,
  startupBatchSize: number | undefined,
): OutboxRecoveryOptions {
  return {
    republishOnStartup: republishOnStartup ?? false,
    startupBatchSize,
  };
}

/**
 * NestJS module that wires the Event Publication Registry:
 * serializer + type registry, repository, publication registry,
 * listener registry + scanner, publisher, async processor, staleness
 * monitor, startup recovery, and the operator-facing query APIs.
 *
 * Does NOT start the processor or staleness monitor automatically —
 * that is a deliberate separation so an API application can publish
 * events without also running the worker loop. Import
 * {@link OutboxProcessingModule} in the worker process to auto-start
 * both on `OnApplicationBootstrap`.
 *
 * Requires `TransactionalModule.forRoot({ isGlobal: true })` to be
 * registered earlier in the module tree so the repository can find
 * the `TransactionManager` via the global DI scope.
 */
@Module({})
export class OutboxModule {
  static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    const processorOptions = resolveProcessorOptions(options.processor, options.completionMode);
    const stalenessConfig = resolveStalenessConfig(options.staleness);
    const recoveryOptions = resolveRecoveryOptions(
      options.republishOnStartup,
      options.startupBatchSize,
    );

    const providers: Provider[] = [
      {
        provide: EVENT_TYPE_REGISTRY,
        useFactory: (): EventTypeRegistry => {
          const registry = new EventTypeRegistry();
          if (options.eventTypes) {
            registry.registerAll(options.eventTypes);
          }
          return registry;
        },
      },
      { provide: EventTypeRegistry, useExisting: EVENT_TYPE_REGISTRY },
      options.serializer ?? {
        provide: EVENT_SERIALIZER,
        useFactory: (registry: EventTypeRegistry): EventSerializer =>
          new JsonEventSerializer(registry),
        inject: [EVENT_TYPE_REGISTRY],
      },
      options.repository ?? {
        provide: EVENT_PUBLICATION_REPOSITORY,
        useClass: InMemoryEventPublicationRepository,
      },
      OutboxListenerRegistry,
      EventPublicationRegistry,
      OutboxEventPublisher,
      OutboxListenerScanner,
      ExternalizationRegistry,
      { provide: OUTBOX_PROCESSOR_OPTIONS, useValue: processorOptions },
      {
        provide: EventPublicationProcessor,
        useFactory: (
          registry: EventPublicationRegistry,
          listeners: OutboxListenerRegistry,
          opts: EventPublicationProcessorOptions,
          externalizer: EventExternalizer | undefined,
          externalizationRegistry: ExternalizationRegistry,
        ) =>
          new EventPublicationProcessor(
            registry,
            listeners,
            opts,
            externalizer,
            externalizationRegistry,
          ),
        inject: [
          EventPublicationRegistry,
          OutboxListenerRegistry,
          OUTBOX_PROCESSOR_OPTIONS,
          { token: EVENT_EXTERNALIZER, optional: true },
          ExternalizationRegistry,
        ],
      },
      { provide: OUTBOX_STALENESS_CONFIG, useValue: stalenessConfig },
      {
        provide: StalenessMonitor,
        useFactory: (repo: EventPublicationRepository, cfg: StalenessConfig) =>
          new StalenessMonitor(repo, cfg),
        inject: [EVENT_PUBLICATION_REPOSITORY, OUTBOX_STALENESS_CONFIG],
      },
      FailedEventPublications,
      IncompleteEventPublications,
      CompletedEventPublications,
      { provide: OUTBOX_RECOVERY_OPTIONS, useValue: recoveryOptions },
      StartupRecoveryService,
    ];

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule],
      providers,
      exports: EXPORTS,
    };
  }

  static forRootAsync(options: OutboxModuleAsyncOptions): DynamicModule {
    const asyncOptionsProvider: FactoryProvider = {
      provide: ASYNC_OPTIONS_TOKEN,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };

    const providers: Provider[] = [
      asyncOptionsProvider,
      {
        provide: EVENT_TYPE_REGISTRY,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): EventTypeRegistry => {
          const registry = new EventTypeRegistry();
          if (opts.eventTypes) {
            registry.registerAll(opts.eventTypes);
          }
          return registry;
        },
        inject: [ASYNC_OPTIONS_TOKEN],
      },
      { provide: EventTypeRegistry, useExisting: EVENT_TYPE_REGISTRY },
      options.serializer ?? {
        provide: EVENT_SERIALIZER,
        useFactory: (registry: EventTypeRegistry): EventSerializer =>
          new JsonEventSerializer(registry),
        inject: [EVENT_TYPE_REGISTRY],
      },
      options.repository ?? {
        provide: EVENT_PUBLICATION_REPOSITORY,
        useClass: InMemoryEventPublicationRepository,
      },
      OutboxListenerRegistry,
      EventPublicationRegistry,
      OutboxEventPublisher,
      OutboxListenerScanner,
      ExternalizationRegistry,
      {
        provide: OUTBOX_PROCESSOR_OPTIONS,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): EventPublicationProcessorOptions =>
          resolveProcessorOptions(opts.processor, opts.completionMode),
        inject: [ASYNC_OPTIONS_TOKEN],
      },
      {
        provide: EventPublicationProcessor,
        useFactory: (
          registry: EventPublicationRegistry,
          listeners: OutboxListenerRegistry,
          opts: EventPublicationProcessorOptions,
          externalizer: EventExternalizer | undefined,
          externalizationRegistry: ExternalizationRegistry,
        ) =>
          new EventPublicationProcessor(
            registry,
            listeners,
            opts,
            externalizer,
            externalizationRegistry,
          ),
        inject: [
          EventPublicationRegistry,
          OutboxListenerRegistry,
          OUTBOX_PROCESSOR_OPTIONS,
          { token: EVENT_EXTERNALIZER, optional: true },
          ExternalizationRegistry,
        ],
      },
      {
        provide: OUTBOX_STALENESS_CONFIG,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): StalenessConfig =>
          resolveStalenessConfig(opts.staleness),
        inject: [ASYNC_OPTIONS_TOKEN],
      },
      {
        provide: StalenessMonitor,
        useFactory: (repo: EventPublicationRepository, cfg: StalenessConfig) =>
          new StalenessMonitor(repo, cfg),
        inject: [EVENT_PUBLICATION_REPOSITORY, OUTBOX_STALENESS_CONFIG],
      },
      FailedEventPublications,
      IncompleteEventPublications,
      CompletedEventPublications,
      {
        provide: OUTBOX_RECOVERY_OPTIONS,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): OutboxRecoveryOptions =>
          resolveRecoveryOptions(opts.republishOnStartup, opts.startupBatchSize),
        inject: [ASYNC_OPTIONS_TOKEN],
      },
      StartupRecoveryService,
    ];

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers,
      exports: EXPORTS,
    };
  }
}
