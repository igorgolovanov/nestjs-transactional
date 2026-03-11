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
import { TransactionManager } from '@nestjs-transactional/core';

import { CompletedEventPublications } from '../api/completed-event-publications';
import { FailedEventPublications } from '../api/failed-event-publications';
import { IncompleteEventPublications } from '../api/incomplete-event-publications';
import { DataSourceOutboxPublisher } from '../dispatcher/data-source-outbox-publisher';
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
import {
  getEventPublicationProcessorToken,
  getEventPublicationRegistryToken,
  getEventPublicationRepositoryToken,
  getEventTypeRegistryToken,
  getExternalizationRegistryToken,
  getOutboxEventSerializerToken,
  getOutboxListenerRegistryToken,
  getOutboxPublisherToken,
} from '../tokens/token-utils';
import { CompletionMode } from '../types/completion-mode';
import { DEFAULT_STALENESS_CONFIG, type StalenessConfig } from '../types/staleness-config';

const DEFAULT_DATA_SOURCE = 'default';

/**
 * Per-dataSource configuration block accepted inside
 * {@link OutboxModuleOptions.dataSources}. Each block produces a
 * complete set of per-dataSource providers under deterministic
 * tokens (`getXxxToken(dataSource)`); the per-dataSource publisher,
 * registry, processor, monitor, and recovery service are independent
 * across dataSources.
 */
export interface OutboxDataSourceOptions {
  /** dataSource name. Defaults to `'default'`. */
  readonly dataSource?: string;
  readonly processor?: Partial<EventPublicationProcessorOptions>;
  readonly staleness?: Partial<StalenessConfig>;
  readonly republishOnStartup?: boolean;
  readonly startupBatchSize?: number;
  /** Convenience shortcut — also fills `processor.completionMode`. */
  readonly completionMode?: CompletionMode;
  /**
   * Provider for the event serializer. The Provider's `provide` field
   * is IGNORED — the module re-binds the provider to
   * `getOutboxEventSerializerToken(dataSource)`. Defaults to a JSON
   * serializer wired to this dataSource's `EventTypeRegistry`.
   */
  readonly serializer?: Provider;
  /**
   * Provider for the event publication repository. Same `provide`
   * re-binding as `serializer`. Defaults to
   * {@link InMemoryEventPublicationRepository} — TESTS ONLY. Production
   * deployments wire a durable backend (`outbox-typeorm`, ...).
   */
  readonly repository?: Provider;
}

/**
 * Synchronous options for {@link OutboxModule.forRoot}. Two shapes
 * supported:
 *
 *  1. **Single-dataSource** (default, backwards-compatible): all
 *     options at the top level apply to the `'default'` dataSource.
 *  2. **Multi-dataSource**: pass {@link dataSources} — an array of
 *     {@link OutboxDataSourceOptions} blocks. Each entry registers a
 *     full per-dataSource provider matrix.
 *
 * **Multi-dataSource via multiple `forRoot()` calls is NOT supported.**
 * NestJS provider deduplication on shared Symbol tokens would make
 * the second call clobber the first. Use `dataSources: [...]` instead.
 *
 * Top-level `processor` / `staleness` / etc. apply ONLY in single-DS
 * mode. When `dataSources` is provided, top-level options are ignored
 * — every dataSource's options come from its block in the array.
 */
export interface OutboxModuleOptions {
  /** Register the module as `@Global()`. Default: `true`. */
  readonly isGlobal?: boolean;

  /**
   * Multi-dataSource configuration. Each entry produces a complete
   * set of per-dataSource providers. Must contain a `'default'` entry
   * (explicit or implicit) for class-token aliases
   * (e.g. `EventPublicationRegistry`, `OutboxEventPublisher`) to
   * remain wired — see {@link OutboxDataSourceOptions} for the
   * per-DS shape.
   */
  readonly dataSources?: readonly OutboxDataSourceOptions[];

  // --- Single-dataSource shortcut: the following options apply to
  //     the `'default'` dataSource when `dataSources` is omitted. ---

  readonly processor?: Partial<EventPublicationProcessorOptions>;
  readonly staleness?: Partial<StalenessConfig>;
  readonly republishOnStartup?: boolean;
  readonly startupBatchSize?: number;
  readonly completionMode?: CompletionMode;
  readonly serializer?: Provider;
  readonly repository?: Provider;
}

/**
 * Subset of {@link OutboxModuleOptions} that can be resolved
 * asynchronously via {@link OutboxModule.forRootAsync}. Provider-valued
 * fields (`serializer`, `repository`) stay static because providers
 * must be known at module-definition time.
 *
 * **Single-dataSource only.** Multi-dataSource is not supported via
 * `forRootAsync` because the dataSource list must be known at module
 * registration time to declare static providers, while the async
 * factory only resolves later. Multi-dataSource deployments use the
 * synchronous `forRoot({ dataSources: [...] })`.
 */
export interface OutboxModuleAsyncFactoryResult {
  readonly processor?: Partial<EventPublicationProcessorOptions>;
  readonly staleness?: Partial<StalenessConfig>;
  readonly republishOnStartup?: boolean;
  readonly startupBatchSize?: number;
  readonly completionMode?: CompletionMode;
}

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

/**
 * Bundle of per-dataSource processors and monitors that
 * {@link OutboxProcessingModule} reads on bootstrap to start every
 * configured outbox loop. Provided by `forRoot` so the processing
 * module needs no per-dataSource configuration of its own.
 */
export const OUTBOX_PROCESSING_BUNDLE = Symbol('OUTBOX_PROCESSING_BUNDLE');

/**
 * Shape of the processing bundle. Both arrays are dataSource-aligned
 * (same length, same order); index `i` describes the i-th dataSource
 * registered with `forRoot`.
 */
export interface OutboxProcessingBundle {
  readonly processors: readonly EventPublicationProcessor[];
  readonly monitors: readonly StalenessMonitor[];
  readonly recoveryServices: readonly StartupRecoveryService[];
}

const ASYNC_OPTIONS_TOKEN = Symbol('OUTBOX_ASYNC_OPTIONS');

function resolveProcessorOptions(
  processor: Partial<EventPublicationProcessorOptions> | undefined,
  completionMode: CompletionMode | undefined,
): EventPublicationProcessorOptions {
  return {
    ...DEFAULT_PROCESSOR_OPTIONS,
    ...processor,
    completionMode:
      completionMode ?? processor?.completionMode ?? DEFAULT_PROCESSOR_OPTIONS.completionMode,
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
 * Resolve user-facing options into a normalised list of per-dataSource
 * config blocks. Multi-DS users supply `dataSources: [...]`; single-DS
 * users supply top-level options that we wrap into a single
 * implicit block under `'default'`.
 */
function resolveDataSourceConfigs(
  options: OutboxModuleOptions,
): readonly OutboxDataSourceOptions[] {
  if (options.dataSources !== undefined && options.dataSources.length > 0) {
    return options.dataSources.map((ds) => ({
      dataSource: ds.dataSource ?? DEFAULT_DATA_SOURCE,
      processor: ds.processor,
      staleness: ds.staleness,
      republishOnStartup: ds.republishOnStartup,
      startupBatchSize: ds.startupBatchSize,
      completionMode: ds.completionMode,
      serializer: ds.serializer,
      repository: ds.repository,
    }));
  }

  return [
    {
      dataSource: DEFAULT_DATA_SOURCE,
      processor: options.processor,
      staleness: options.staleness,
      republishOnStartup: options.republishOnStartup,
      startupBatchSize: options.startupBatchSize,
      completionMode: options.completionMode,
      serializer: options.serializer,
      repository: options.repository,
    },
  ];
}

/**
 * Re-bind a Provider's `provide` field to a per-dataSource token.
 * Users supply repository / serializer providers with whatever
 * `provide` value they want (typically the historical singleton
 * tokens) — the module owns the actual token routing per-dataSource
 * and overwrites `provide` here.
 */
function reBindProvider(provider: Provider, token: InjectionToken): Provider {
  if (typeof provider === 'function') {
    return { provide: token, useClass: provider };
  }
  return { ...provider, provide: token };
}

/**
 * NestJS module that wires the Event Publication Registry. Phase 14.3
 * extended `forRoot` to register a complete per-dataSource provider
 * matrix when {@link OutboxModuleOptions.dataSources} is given —
 * single-dataSource deployments continue to use the top-level options
 * shorthand (everything binds to dataSource `'default'`).
 *
 * Does NOT start the processor or staleness monitor automatically —
 * import {@link OutboxProcessingModule} in the worker process to
 * auto-start every configured per-dataSource loop on
 * `OnApplicationBootstrap`.
 *
 * Requires `TransactionalModule.forRoot({ isGlobal: true })` registered
 * earlier in the module tree so the per-DS publisher can find the
 * `TransactionManager` via the global DI scope.
 */
@Module({})
export class OutboxModule {
  static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    const dsConfigs = resolveDataSourceConfigs(options);
    // resolveDataSourceConfigs guarantees `dataSource` is set for
    // every entry — non-null is provably safe here.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dsNames = dsConfigs.map((d) => d.dataSource!);

    const providers: Provider[] = [];
    const exportTokens: InjectionToken[] = [];

    // Per-dataSource provider matrix. Each iteration registers the
    // full set of providers (event-type registry, repository,
    // serializer, publication registry, listener registry,
    // externalization registry, processor, staleness monitor, startup
    // recovery, per-dataSource publisher, operator query APIs) under
    // dataSource-derived tokens.
    for (const dsConfig of dsConfigs) {
      providers.push(...buildPerDataSourceProviders(dsConfig));
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      exportTokens.push(...perDataSourceExports(dsConfig.dataSource!));
    }

    // Class-token / singleton-token aliases for the `'default'`
    // dataSource. Preserves the historical contract where
    // `module.get(EventPublicationRegistry)` and
    // `@Inject(EVENT_PUBLICATION_REPOSITORY)` resolve to the
    // single-dataSource instance. Operator APIs follow because they
    // inject from the EVENT_PUBLICATION_REPOSITORY alias above.
    if (dsNames.includes(DEFAULT_DATA_SOURCE)) {
      providers.push(...buildDefaultDataSourceAliases());
      providers.push(
        FailedEventPublications,
        IncompleteEventPublications,
        CompletedEventPublications,
        StartupRecoveryService,
      );
      exportTokens.push(...defaultDataSourceAliasTokens());
      exportTokens.push(
        FailedEventPublications,
        IncompleteEventPublications,
        CompletedEventPublications,
        StartupRecoveryService,
      );
    }

    // Smart facade publisher (DD-024). Constructed via factory
    // injecting every per-dataSource publisher and event-type
    // registry — the facade builds Maps keyed by dataSource name.
    providers.push(buildFacadePublisherProvider(dsNames));
    exportTokens.push(OutboxEventPublisher);

    // Module-wide singletons that don't vary per-dataSource.
    providers.push(OutboxListenerScanner);

    // Processing bundle exposed for OutboxProcessingModule.
    providers.push(buildProcessingBundleProvider(dsNames));
    exportTokens.push(OUTBOX_PROCESSING_BUNDLE);

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule],
      providers,
      exports: exportTokens,
    };
  }

  /**
   * Register event classes that the outbox should know about — typed
   * inputs to the per-dataSource `EventTypeRegistry` so the JSON
   * serializer can revive stored payloads back into class instances,
   * and so externalization mappings (`@Externalized`) can be picked
   * up by the registry scan.
   *
   * @param eventTypes Event classes to register. Empty array is a
   *   no-op (matches `TypeOrmModule.forFeature([])`).
   * @param options Optional per-call options. `dataSource` defaults
   *   to `'default'` — single-dataSource consumers omit it.
   *
   * @example Single-dataSource
   * ```ts
   * OutboxModule.forFeature([OrderPlacedEvent, OrderShippedEvent])
   * ```
   *
   * @example Multi-dataSource (Phase 14.3)
   * ```ts
   * OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' })
   * OutboxModule.forFeature([InventoryEvent], { dataSource: 'inventory' })
   * ```
   *
   * Multiple `forFeature` calls accumulate into the per-dataSource
   * registry. Duplicate registrations (same event class, same
   * dataSource) throw at bootstrap with a clear message.
   */
  static forFeature(
    eventTypes: Type<object>[],
    options: { readonly dataSource?: string } = {},
  ): DynamicModule {
    const dataSource = options.dataSource ?? DEFAULT_DATA_SOURCE;
    // Symbol() (not Symbol.for) — each forFeature call gets a unique
    // token so multiple imports in the same or different modules
    // don't collide. The factory runs eagerly (singleton scope) for
    // its side effect: registering the listed event classes with the
    // per-dataSource EventTypeRegistry.
    const featureToken = Symbol(`OUTBOX_FEATURE_REGISTRATION[${dataSource}]`);

    return {
      module: OutboxModule,
      providers: [
        {
          provide: featureToken,
          useFactory: (registry: EventTypeRegistry): true => {
            for (const eventType of eventTypes) {
              registry.register(eventType);
            }
            return true;
          },
          inject: [getEventTypeRegistryToken(dataSource)],
        },
      ],
    };
  }

  /**
   * Asynchronous registration. **Single-dataSource only** —
   * multi-dataSource deployments must use the synchronous
   * `forRoot({ dataSources: [...] })`. The async factory result
   * cannot declare provider tokens because providers must be known
   * at module-definition time, while the factory only runs later.
   */
  static forRootAsync(options: OutboxModuleAsyncOptions): DynamicModule {
    const asyncOptionsProvider: FactoryProvider = {
      provide: ASYNC_OPTIONS_TOKEN,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };

    const ds = DEFAULT_DATA_SOURCE;
    const eventTypeRegistryToken = getEventTypeRegistryToken(ds);
    const repositoryToken = getEventPublicationRepositoryToken(ds);
    const serializerToken = getOutboxEventSerializerToken(ds);
    const listenerRegistryToken = getOutboxListenerRegistryToken(ds);
    const publicationRegistryToken = getEventPublicationRegistryToken(ds);
    const externalizationRegistryToken = getExternalizationRegistryToken(ds);
    const processorToken = getEventPublicationProcessorToken(ds);
    const publisherToken = getOutboxPublisherToken(ds);
    const stalenessToken = `${ds}StalenessMonitor`;
    const recoveryToken = `${ds}StartupRecoveryService`;
    const processorOptionsToken = `${ds}ProcessorOptions`;
    const stalenessConfigToken = `${ds}StalenessConfig`;
    const recoveryOptionsToken = `${ds}RecoveryOptions`;

    const providers: Provider[] = [
      asyncOptionsProvider,

      // Per-DS event type registry
      {
        provide: eventTypeRegistryToken,
        useFactory: (): EventTypeRegistry => new EventTypeRegistry(),
      },

      // Repository (per-DS)
      options.repository
        ? reBindProvider(options.repository, repositoryToken)
        : { provide: repositoryToken, useClass: InMemoryEventPublicationRepository },

      // Serializer (per-DS)
      options.serializer
        ? reBindProvider(options.serializer, serializerToken)
        : {
            provide: serializerToken,
            useFactory: (registry: EventTypeRegistry): EventSerializer =>
              new JsonEventSerializer(registry),
            inject: [eventTypeRegistryToken],
          },

      // Listener registry (per-DS)
      {
        provide: listenerRegistryToken,
        useFactory: (): OutboxListenerRegistry => new OutboxListenerRegistry(),
      },

      // Publication registry (per-DS)
      {
        provide: publicationRegistryToken,
        useFactory: (
          repo: EventPublicationRepository,
          serializer: EventSerializer,
        ): EventPublicationRegistry => new EventPublicationRegistry(repo, serializer),
        inject: [repositoryToken, serializerToken],
      },

      // Externalization registry (per-DS)
      {
        provide: externalizationRegistryToken,
        useFactory: (etr: EventTypeRegistry): ExternalizationRegistry =>
          new ExternalizationRegistry(etr),
        inject: [eventTypeRegistryToken],
      },

      // Processor options resolved from async factory
      {
        provide: processorOptionsToken,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): EventPublicationProcessorOptions =>
          resolveProcessorOptions(opts.processor, opts.completionMode),
        inject: [ASYNC_OPTIONS_TOKEN],
      },

      // Processor (per-DS)
      {
        provide: processorToken,
        useFactory: (
          registry: EventPublicationRegistry,
          listeners: OutboxListenerRegistry,
          opts: EventPublicationProcessorOptions,
          externalizer: EventExternalizer | undefined,
          externalizationRegistry: ExternalizationRegistry,
        ): EventPublicationProcessor =>
          new EventPublicationProcessor(
            registry,
            listeners,
            opts,
            externalizer,
            externalizationRegistry,
          ),
        inject: [
          publicationRegistryToken,
          listenerRegistryToken,
          processorOptionsToken,
          { token: EVENT_EXTERNALIZER, optional: true },
          externalizationRegistryToken,
        ],
      },

      // Staleness config / monitor (per-DS)
      {
        provide: stalenessConfigToken,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): StalenessConfig =>
          resolveStalenessConfig(opts.staleness),
        inject: [ASYNC_OPTIONS_TOKEN],
      },
      {
        provide: stalenessToken,
        useFactory: (repo: EventPublicationRepository, cfg: StalenessConfig): StalenessMonitor =>
          new StalenessMonitor(repo, cfg),
        inject: [repositoryToken, stalenessConfigToken],
      },

      // Recovery options / service (per-DS).
      // StartupRecoveryService is registered as a class via the
      // default-DS alias path below — it injects
      // IncompleteEventPublications + OUTBOX_RECOVERY_OPTIONS (both
      // class-token aliased), so NestJS handles construction.
      {
        provide: recoveryOptionsToken,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): OutboxRecoveryOptions =>
          resolveRecoveryOptions(opts.republishOnStartup, opts.startupBatchSize),
        inject: [ASYNC_OPTIONS_TOKEN],
      },
      { provide: recoveryToken, useExisting: StartupRecoveryService },

      // Per-DS internal publisher
      {
        provide: publisherToken,
        useFactory: (
          publicationRegistry: EventPublicationRegistry,
          listenerRegistry: OutboxListenerRegistry,
        ): DataSourceOutboxPublisher =>
          new DataSourceOutboxPublisher(ds, publicationRegistry, listenerRegistry),
        inject: [publicationRegistryToken, listenerRegistryToken],
      },

      // Class-token aliases for backwards compatibility — these
      // include the EVENT_PUBLICATION_REPOSITORY alias the operator
      // APIs below inject from.
      ...buildDefaultDataSourceAliases(),

      // Operator APIs + StartupRecoveryService — registered as
      // classes so NestJS resolves their dependencies via DI from
      // the default-DS alias above.
      FailedEventPublications,
      IncompleteEventPublications,
      CompletedEventPublications,
      StartupRecoveryService,

      // Module-wide singletons
      OutboxListenerScanner,

      // Smart facade publisher
      buildFacadePublisherProvider([ds]),

      // Processing bundle
      buildProcessingBundleProvider([ds]),
    ];

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers,
      exports: [
        ...perDataSourceExports(ds),
        ...defaultDataSourceAliasTokens(),
        OutboxEventPublisher,
        OUTBOX_PROCESSING_BUNDLE,
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// Per-dataSource provider helpers
// ---------------------------------------------------------------------------

function buildPerDataSourceProviders(dsConfig: OutboxDataSourceOptions): Provider[] {
  // dsConfig.dataSource is filled in by resolveDataSourceConfigs.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const ds = dsConfig.dataSource!;
  const eventTypeRegistryToken = getEventTypeRegistryToken(ds);
  const repositoryToken = getEventPublicationRepositoryToken(ds);
  const serializerToken = getOutboxEventSerializerToken(ds);
  const listenerRegistryToken = getOutboxListenerRegistryToken(ds);
  const publicationRegistryToken = getEventPublicationRegistryToken(ds);
  const externalizationRegistryToken = getExternalizationRegistryToken(ds);
  const processorToken = getEventPublicationProcessorToken(ds);
  const publisherToken = getOutboxPublisherToken(ds);
  // Internal-only string tokens for per-DS components without a
  // dedicated `getXxxToken` utility (staleness, recovery, options).
  // Not part of the public token-utility surface — Phase 14.x can
  // promote them later if a real injection use case emerges.
  const stalenessToken = `${ds}StalenessMonitor`;
  const recoveryToken = `${ds}StartupRecoveryService`;
  const processorOptionsToken = `${ds}ProcessorOptions`;
  const stalenessConfigToken = `${ds}StalenessConfig`;
  const recoveryOptionsToken = `${ds}RecoveryOptions`;

  const processorOpts = resolveProcessorOptions(dsConfig.processor, dsConfig.completionMode);
  const stalenessCfg = resolveStalenessConfig(dsConfig.staleness);
  const recoveryOpts = resolveRecoveryOptions(
    dsConfig.republishOnStartup,
    dsConfig.startupBatchSize,
  );

  return [
    { provide: eventTypeRegistryToken, useFactory: (): EventTypeRegistry => new EventTypeRegistry() },

    dsConfig.repository
      ? reBindProvider(dsConfig.repository, repositoryToken)
      : { provide: repositoryToken, useClass: InMemoryEventPublicationRepository },

    dsConfig.serializer
      ? reBindProvider(dsConfig.serializer, serializerToken)
      : {
          provide: serializerToken,
          useFactory: (registry: EventTypeRegistry): EventSerializer =>
            new JsonEventSerializer(registry),
          inject: [eventTypeRegistryToken],
        },

    {
      provide: listenerRegistryToken,
      useFactory: (): OutboxListenerRegistry => new OutboxListenerRegistry(),
    },

    {
      provide: publicationRegistryToken,
      useFactory: (
        repo: EventPublicationRepository,
        serializer: EventSerializer,
      ): EventPublicationRegistry => new EventPublicationRegistry(repo, serializer),
      inject: [repositoryToken, serializerToken],
    },

    {
      provide: externalizationRegistryToken,
      useFactory: (etr: EventTypeRegistry): ExternalizationRegistry =>
        new ExternalizationRegistry(etr),
      inject: [eventTypeRegistryToken],
    },

    { provide: processorOptionsToken, useValue: processorOpts },
    {
      provide: processorToken,
      useFactory: (
        registry: EventPublicationRegistry,
        listeners: OutboxListenerRegistry,
        opts: EventPublicationProcessorOptions,
        externalizer: EventExternalizer | undefined,
        externalizationRegistry: ExternalizationRegistry,
      ): EventPublicationProcessor =>
        new EventPublicationProcessor(
          registry,
          listeners,
          opts,
          externalizer,
          externalizationRegistry,
        ),
      inject: [
        publicationRegistryToken,
        listenerRegistryToken,
        processorOptionsToken,
        { token: EVENT_EXTERNALIZER, optional: true },
        externalizationRegistryToken,
      ],
    },

    { provide: stalenessConfigToken, useValue: stalenessCfg },
    {
      provide: stalenessToken,
      useFactory: (repo: EventPublicationRepository, cfg: StalenessConfig): StalenessMonitor =>
        new StalenessMonitor(repo, cfg),
      inject: [repositoryToken, stalenessConfigToken],
    },

    { provide: recoveryOptionsToken, useValue: recoveryOpts },
    // StartupRecoveryService takes IncompleteEventPublications +
    // OutboxRecoveryOptions, both class-token-aliased to the default
    // DS. Register as class so NestJS resolves both via DI.
    {
      provide: recoveryToken,
      useExisting: StartupRecoveryService,
    },

    {
      provide: publisherToken,
      useFactory: (
        publicationRegistry: EventPublicationRegistry,
        listenerRegistry: OutboxListenerRegistry,
      ): DataSourceOutboxPublisher =>
        new DataSourceOutboxPublisher(ds, publicationRegistry, listenerRegistry),
      inject: [publicationRegistryToken, listenerRegistryToken],
    },
  ];
}

function perDataSourceExports(ds: string): InjectionToken[] {
  return [
    getEventTypeRegistryToken(ds),
    getEventPublicationRepositoryToken(ds),
    getOutboxEventSerializerToken(ds),
    getOutboxListenerRegistryToken(ds),
    getEventPublicationRegistryToken(ds),
    getExternalizationRegistryToken(ds),
    getEventPublicationProcessorToken(ds),
    getOutboxPublisherToken(ds),
  ];
}

/**
 * Class-token / singleton-token aliases for the `'default'` dataSource.
 * These exist so that historical injection sites
 * (`@Inject(EVENT_PUBLICATION_REPOSITORY)`,
 * `module.get(EventPublicationRegistry)`, etc.) keep working when
 * the only configured dataSource is `'default'` — the typical
 * single-DS deployment.
 */
function buildDefaultDataSourceAliases(): Provider[] {
  const ds = DEFAULT_DATA_SOURCE;
  return [
    { provide: EVENT_TYPE_REGISTRY, useExisting: getEventTypeRegistryToken(ds) },
    { provide: EventTypeRegistry, useExisting: getEventTypeRegistryToken(ds) },
    { provide: EVENT_SERIALIZER, useExisting: getOutboxEventSerializerToken(ds) },
    { provide: EVENT_PUBLICATION_REPOSITORY, useExisting: getEventPublicationRepositoryToken(ds) },
    { provide: OutboxListenerRegistry, useExisting: getOutboxListenerRegistryToken(ds) },
    { provide: EventPublicationRegistry, useExisting: getEventPublicationRegistryToken(ds) },
    { provide: ExternalizationRegistry, useExisting: getExternalizationRegistryToken(ds) },
    { provide: EventPublicationProcessor, useExisting: getEventPublicationProcessorToken(ds) },
    { provide: StalenessMonitor, useExisting: `${ds}StalenessMonitor` },
    { provide: StartupRecoveryService, useExisting: `${ds}StartupRecoveryService` },
    { provide: OUTBOX_PROCESSOR_OPTIONS, useExisting: `${ds}ProcessorOptions` },
    { provide: OUTBOX_STALENESS_CONFIG, useExisting: `${ds}StalenessConfig` },
    { provide: OUTBOX_RECOVERY_OPTIONS, useExisting: `${ds}RecoveryOptions` },
  ];
}

function defaultDataSourceAliasTokens(): InjectionToken[] {
  return [
    EVENT_TYPE_REGISTRY,
    EventTypeRegistry,
    EVENT_SERIALIZER,
    EVENT_PUBLICATION_REPOSITORY,
    OutboxListenerRegistry,
    EventPublicationRegistry,
    ExternalizationRegistry,
    EventPublicationProcessor,
    StalenessMonitor,
    StartupRecoveryService,
    OUTBOX_PROCESSOR_OPTIONS,
    OUTBOX_STALENESS_CONFIG,
    OUTBOX_RECOVERY_OPTIONS,
  ];
}

/**
 * Factory provider for the smart-facade {@link OutboxEventPublisher}.
 * Injects every per-dataSource publisher and event-type registry,
 * builds Maps keyed by dataSource name, and constructs the facade.
 */
function buildFacadePublisherProvider(dsNames: readonly string[]): Provider {
  const publisherTokens = dsNames.map((ds) => getOutboxPublisherToken(ds));
  const eventTypeRegistryTokens = dsNames.map((ds) => getEventTypeRegistryToken(ds));

  return {
    provide: OutboxEventPublisher,
    useFactory: (...args: unknown[]): OutboxEventPublisher => {
      const publishers = new Map<string, DataSourceOutboxPublisher>();
      const registries = new Map<string, EventTypeRegistry>();
      for (let i = 0; i < dsNames.length; i++) {
        const name = dsNames[i];
        if (name === undefined) continue;
        publishers.set(name, args[i] as DataSourceOutboxPublisher);
        registries.set(name, args[dsNames.length + i] as EventTypeRegistry);
      }
      return new OutboxEventPublisher(publishers, registries);
    },
    inject: [...publisherTokens, ...eventTypeRegistryTokens],
  };
}

/**
 * Factory provider for {@link OUTBOX_PROCESSING_BUNDLE}. The bundle
 * is read by {@link OutboxProcessingModule} on bootstrap to start
 * every configured per-dataSource processor / monitor / recovery
 * service.
 */
function buildProcessingBundleProvider(dsNames: readonly string[]): Provider {
  const processorTokens = dsNames.map((ds) => getEventPublicationProcessorToken(ds));
  const monitorTokens = dsNames.map((ds) => `${ds}StalenessMonitor`);
  const recoveryTokens = dsNames.map((ds) => `${ds}StartupRecoveryService`);

  return {
    provide: OUTBOX_PROCESSING_BUNDLE,
    useFactory: (...args: unknown[]): OutboxProcessingBundle => {
      const n = dsNames.length;
      return {
        processors: args.slice(0, n) as EventPublicationProcessor[],
        monitors: args.slice(n, 2 * n) as StalenessMonitor[],
        recoveryServices: args.slice(2 * n, 3 * n) as StartupRecoveryService[],
      };
    },
    inject: [...processorTokens, ...monitorTokens, ...recoveryTokens],
  };
}

// `TransactionManager` referenced for documentation completeness;
// no longer used directly in this file after Phase 14.3 (the per-DS
// publisher pushes hooks directly onto the active-transaction object,
// bypassing manager.registerBeforeCommit's single-tx assumption).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _txManagerRef = TransactionManager;
