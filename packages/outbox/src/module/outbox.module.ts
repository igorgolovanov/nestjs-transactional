import {
  type DynamicModule,
  type FactoryProvider,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
  type Type,
} from '@nestjs/common';
import { DiscoveryModule, ModuleRef } from '@nestjs/core';
import { TransactionManager } from '@nestjs-transactional/core';

import { CompletedEventPublications } from '../api/completed-event-publications';
import { FailedEventPublications } from '../api/failed-event-publications';
import { IncompleteEventPublications } from '../api/incomplete-event-publications';
import { DataSourceOutboxPublisher } from '../dispatcher/data-source-outbox-publisher';
import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import {
  OUTBOX_DATA_SOURCE_NAMES,
  OutboxEventPublisher,
} from '../dispatcher/outbox-event-publisher';
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
import {
  MultiDsOutboxListenerRegistrar,
  OUTBOX_LISTENER_REGISTRAR_TOKEN,
} from '../registry/multi-ds-listener-registrar';
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
 * Synchronous options for {@link OutboxModule.forRoot}.
 *
 * Multi-dataSource deployments call `forRoot` once per dataSource:
 *
 * ```ts
 * OutboxModule.forRoot({})                              // default
 * OutboxModule.forRoot({ dataSource: 'billing' })       // billing
 * OutboxModule.forRoot({ dataSource: 'inventory' })     // inventory
 * ```
 *
 * Matches the convention used by `TypeOrmModule`, `MongooseModule`,
 * `ClientsModule`, and others — each `forRoot` call registers a
 * complete provider matrix for one dataSource. Cross-call
 * coordination of the singleton facade / scanner / processing bundle
 * happens through {@link OutboxModule.registrations} (static class
 * storage, mirroring `@nestjs/typeorm`'s `EntitiesMetadataStorage`).
 *
 * Calling `forRoot` twice with the same `dataSource` (or twice with
 * `dataSource` omitted, which both default to `'default'`) throws at
 * module-definition time — dataSource names must be unique across a
 * process.
 *
 * Tests that build multiple modules in sequence must reset the
 * static storage between cases — call {@link OutboxModule.resetForTesting}
 * in `beforeEach` (or `afterEach`).
 */
export interface OutboxModuleOptions {
  /** dataSource name. Defaults to `'default'`. */
  readonly dataSource?: string;
  /** Register the module as `@Global()`. Default: `true`. */
  readonly isGlobal?: boolean;

  readonly processor?: Partial<EventPublicationProcessorOptions>;
  readonly staleness?: Partial<StalenessConfig>;
  readonly republishOnStartup?: boolean;
  readonly startupBatchSize?: number;
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
 * Result shape resolved by {@link OutboxModuleAsyncOptions.useFactory}.
 * Provider-valued fields (`serializer`, `repository`) stay static
 * because providers must be known at module-definition time.
 */
export interface OutboxModuleAsyncFactoryResult {
  readonly processor?: Partial<EventPublicationProcessorOptions>;
  readonly staleness?: Partial<StalenessConfig>;
  readonly republishOnStartup?: boolean;
  readonly startupBatchSize?: number;
  readonly completionMode?: CompletionMode;
}

/**
 * Asynchronous options for {@link OutboxModule.forRootAsync}. Each
 * call registers a single dataSource's outbox stack with config
 * resolved asynchronously. Multi-dataSource deployments call
 * `forRootAsync` once per dataSource (symmetric with `forRoot`).
 */
export interface OutboxModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly dataSource?: string;
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
 * Shape of the processing bundle. The three arrays are aligned by
 * index — `processors[i]` / `monitors[i]` / `recoveryServices[i]`
 * all belong to the same dataSource.
 */
export interface OutboxProcessingBundle {
  readonly processors: readonly EventPublicationProcessor[];
  readonly monitors: readonly StalenessMonitor[];
  readonly recoveryServices: readonly StartupRecoveryService[];
}

/**
 * Internal record of a registered dataSource's resolved options.
 * Stored in {@link OutboxModule.registrations} so singleton factories
 * can enumerate every registered dataSource at injection time.
 */
interface OutboxRegistrationRecord {
  readonly dataSource: string;
  readonly processorOptions: EventPublicationProcessorOptions;
  readonly stalenessConfig: StalenessConfig;
  readonly recoveryOptions: OutboxRecoveryOptions;
}

const ASYNC_OPTIONS_TOKEN = (ds: string): symbol =>
  Symbol(`OUTBOX_ASYNC_OPTIONS[${ds}]`);

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
 * NestJS module that wires the Event Publication Registry. ADR-019
 * shape — multi-dataSource deployments call {@link forRoot} once per
 * dataSource. The first call registers process-wide singletons (smart
 * facade, listener scanner, processing bundle); subsequent calls only
 * register per-dataSource providers. Default-DS class-token aliases
 * are registered by whichever call has `dataSource: 'default'` (or
 * `dataSource` omitted).
 *
 * Cross-call state lives in {@link registrations} — a static class
 * storage keyed by dataSource name. Mirrors `@nestjs/typeorm`'s
 * `EntitiesMetadataStorage` pattern.
 *
 * Does NOT start the processor or staleness monitor automatically —
 * import {@link OutboxProcessingModule} in the worker process to
 * auto-start every registered per-dataSource loop on
 * `OnApplicationBootstrap`.
 *
 * Requires `TransactionalModule.forRoot({ isGlobal: true })` registered
 * earlier in the module tree so the per-DS publisher can find the
 * `TransactionManager` via the global DI scope.
 */
@Module({})
export class OutboxModule {
  /**
   * @internal
   * Process-wide registry of every dataSource that has called
   * {@link forRoot} or {@link forRootAsync}. Singleton factories
   * (smart facade, processing bundle) close over this Map and
   * enumerate it at injection time, after every `forRoot` has been
   * evaluated synchronously.
   *
   * Tests that build multiple modules sequentially MUST call
   * {@link resetForTesting} between cases — otherwise residual
   * registrations from earlier tests collide with later ones.
   */
  private static readonly registrations = new Map<string, OutboxRegistrationRecord>();

  /**
   * Test-only — drop every registration so a subsequent `forRoot`
   * starts from a clean slate. Mirrors the cleanup pattern used with
   * `EntitiesMetadataStorage` in `@nestjs/typeorm` test suites.
   *
   * Production code should never call this. Calling at runtime
   * after the module has been initialised would NOT clear the
   * provider tree NestJS already built — it only clears the
   * registration record that drives subsequent `forRoot` calls.
   *
   * @internal
   */
  static resetForTesting(): void {
    this.registrations.clear();
  }

  static forRoot(options: OutboxModuleOptions = {}): DynamicModule {
    const ds = options.dataSource ?? DEFAULT_DATA_SOURCE;
    if (this.registrations.has(ds)) {
      throw new Error(
        `OutboxModule.forRoot('${ds}') called twice — dataSource names must be unique. ` +
          `If this is a test, call OutboxModule.resetForTesting() between cases.`,
      );
    }

    const isFirstRegistration = this.registrations.size === 0;

    const processorOpts = resolveProcessorOptions(options.processor, options.completionMode);
    const stalenessCfg = resolveStalenessConfig(options.staleness);
    const recoveryOpts = resolveRecoveryOptions(
      options.republishOnStartup,
      options.startupBatchSize,
    );

    this.registrations.set(ds, {
      dataSource: ds,
      processorOptions: processorOpts,
      stalenessConfig: stalenessCfg,
      recoveryOptions: recoveryOpts,
    });

    const providers: Provider[] = [
      ...buildPerDataSourceProviders(
        ds,
        options.repository,
        options.serializer,
        processorOpts,
        stalenessCfg,
        recoveryOpts,
      ),
    ];
    const exportTokens: InjectionToken[] = [...perDataSourceExports(ds)];

    if (ds === DEFAULT_DATA_SOURCE) {
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

    if (isFirstRegistration) {
      // Process-wide singletons. Their factories close over this
      // class's `registrations` Map and read it at injection time —
      // by then every other forRoot has already pushed its record in
      // (forRoot bodies run synchronously at module-definition time).
      providers.push(...buildFacadePublisherProvider(OutboxModule));
      providers.push(buildProcessingBundleProvider(OutboxModule));
      providers.push(OutboxListenerScanner);
      providers.push(...buildMultiDsRegistrarProviders());
      exportTokens.push(OutboxEventPublisher);
      exportTokens.push(OUTBOX_PROCESSING_BUNDLE);
      exportTokens.push(MultiDsOutboxListenerRegistrar);
      exportTokens.push(OUTBOX_LISTENER_REGISTRAR_TOKEN);
    }

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule],
      providers,
      exports: exportTokens,
    };
  }

  /**
   * Asynchronous registration of one dataSource's outbox stack.
   * Symmetric with {@link forRoot} — call once per dataSource;
   * provider-valued fields (`serializer`, `repository`) stay static
   * because providers must be known at module-definition time, while
   * `processor` / `staleness` / etc. resolve via the async factory.
   */
  static forRootAsync(options: OutboxModuleAsyncOptions): DynamicModule {
    const ds = options.dataSource ?? DEFAULT_DATA_SOURCE;
    if (this.registrations.has(ds)) {
      throw new Error(
        `OutboxModule.forRootAsync('${ds}') called twice — dataSource names must be unique. ` +
          `If this is a test, call OutboxModule.resetForTesting() between cases.`,
      );
    }

    const isFirstRegistration = this.registrations.size === 0;

    // Stub the registration record with defaults — async factory hasn't
    // run yet, so concrete options are filled in by per-DS factory
    // providers below. Singletons that read the Map at injection time
    // only consume `dataSource`, so this stub is sufficient.
    this.registrations.set(ds, {
      dataSource: ds,
      processorOptions: resolveProcessorOptions(undefined, undefined),
      stalenessConfig: resolveStalenessConfig(undefined),
      recoveryOptions: resolveRecoveryOptions(undefined, undefined),
    });

    const asyncToken = ASYNC_OPTIONS_TOKEN(ds);
    const asyncOptionsProvider: FactoryProvider = {
      provide: asyncToken,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };

    const eventTypeRegistryToken = getEventTypeRegistryToken(ds);
    const repositoryToken = getEventPublicationRepositoryToken(ds);
    const serializerToken = getOutboxEventSerializerToken(ds);
    const listenerRegistryToken = getOutboxListenerRegistryToken(ds);
    const publicationRegistryToken = getEventPublicationRegistryToken(ds);
    const externalizationRegistryToken = getExternalizationRegistryToken(ds);
    const processorToken = getEventPublicationProcessorToken(ds);
    const publisherToken = getOutboxPublisherToken(ds);
    const stalenessToken = perDsStalenessMonitorToken(ds);
    const recoveryToken = perDsStartupRecoveryToken(ds);
    const processorOptionsToken = perDsProcessorOptionsToken(ds);
    const stalenessConfigToken = perDsStalenessConfigToken(ds);
    const recoveryOptionsToken = perDsRecoveryOptionsToken(ds);

    const providers: Provider[] = [
      asyncOptionsProvider,

      { provide: eventTypeRegistryToken, useFactory: (): EventTypeRegistry => new EventTypeRegistry() },

      options.repository
        ? reBindProvider(options.repository, repositoryToken)
        : { provide: repositoryToken, useClass: InMemoryEventPublicationRepository },

      options.serializer
        ? reBindProvider(options.serializer, serializerToken)
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

      {
        provide: processorOptionsToken,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): EventPublicationProcessorOptions =>
          resolveProcessorOptions(opts.processor, opts.completionMode),
        inject: [asyncToken],
      },
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

      {
        provide: stalenessConfigToken,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): StalenessConfig =>
          resolveStalenessConfig(opts.staleness),
        inject: [asyncToken],
      },
      {
        provide: stalenessToken,
        useFactory: (repo: EventPublicationRepository, cfg: StalenessConfig): StalenessMonitor =>
          new StalenessMonitor(repo, cfg),
        inject: [repositoryToken, stalenessConfigToken],
      },

      {
        provide: recoveryOptionsToken,
        useFactory: (opts: OutboxModuleAsyncFactoryResult): OutboxRecoveryOptions =>
          resolveRecoveryOptions(opts.republishOnStartup, opts.startupBatchSize),
        inject: [asyncToken],
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

    const exportTokens: InjectionToken[] = [...perDataSourceExports(ds)];

    if (ds === DEFAULT_DATA_SOURCE) {
      providers.push(
        { provide: recoveryToken, useExisting: StartupRecoveryService },
        ...buildDefaultDataSourceAliases(),
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

    if (isFirstRegistration) {
      providers.push(...buildFacadePublisherProvider(OutboxModule));
      providers.push(buildProcessingBundleProvider(OutboxModule));
      providers.push(OutboxListenerScanner);
      providers.push(...buildMultiDsRegistrarProviders());
      exportTokens.push(OutboxEventPublisher);
      exportTokens.push(OUTBOX_PROCESSING_BUNDLE);
      exportTokens.push(MultiDsOutboxListenerRegistrar);
      exportTokens.push(OUTBOX_LISTENER_REGISTRAR_TOKEN);
    }

    return {
      module: OutboxModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
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
   * @example Multi-dataSource
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
}

// ---------------------------------------------------------------------------
// Per-dataSource provider helpers
// ---------------------------------------------------------------------------

function perDsStalenessMonitorToken(ds: string): string {
  return `${ds}StalenessMonitor`;
}
function perDsStartupRecoveryToken(ds: string): string {
  return `${ds}StartupRecoveryService`;
}
function perDsProcessorOptionsToken(ds: string): string {
  return `${ds}ProcessorOptions`;
}
function perDsStalenessConfigToken(ds: string): string {
  return `${ds}StalenessConfig`;
}
function perDsRecoveryOptionsToken(ds: string): string {
  return `${ds}RecoveryOptions`;
}

function buildPerDataSourceProviders(
  ds: string,
  repository: Provider | undefined,
  serializer: Provider | undefined,
  processorOpts: EventPublicationProcessorOptions,
  stalenessCfg: StalenessConfig,
  recoveryOpts: OutboxRecoveryOptions,
): Provider[] {
  const eventTypeRegistryToken = getEventTypeRegistryToken(ds);
  const repositoryToken = getEventPublicationRepositoryToken(ds);
  const serializerToken = getOutboxEventSerializerToken(ds);
  const listenerRegistryToken = getOutboxListenerRegistryToken(ds);
  const publicationRegistryToken = getEventPublicationRegistryToken(ds);
  const externalizationRegistryToken = getExternalizationRegistryToken(ds);
  const processorToken = getEventPublicationProcessorToken(ds);
  const publisherToken = getOutboxPublisherToken(ds);
  const stalenessToken = perDsStalenessMonitorToken(ds);
  const recoveryToken = perDsStartupRecoveryToken(ds);
  const processorOptionsToken = perDsProcessorOptionsToken(ds);
  const stalenessConfigToken = perDsStalenessConfigToken(ds);
  const recoveryOptionsToken = perDsRecoveryOptionsToken(ds);

  return [
    { provide: eventTypeRegistryToken, useFactory: (): EventTypeRegistry => new EventTypeRegistry() },

    repository
      ? reBindProvider(repository, repositoryToken)
      : { provide: repositoryToken, useClass: InMemoryEventPublicationRepository },

    serializer
      ? reBindProvider(serializer, serializerToken)
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
        s: EventSerializer,
      ): EventPublicationRegistry => new EventPublicationRegistry(repo, s),
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
    // StartupRecoveryService for non-default dataSources alias to the
    // class-token instance registered by the default-DS forRoot. The
    // class-token instance reads IncompleteEventPublications +
    // OUTBOX_RECOVERY_OPTIONS — both bound to the default-DS
    // repository. For multi-DS recovery to fire per-dataSource we'd
    // need a per-DS StartupRecoveryService class; deferred to a later
    // phase when multi-DS recovery is exercised. Today's behaviour:
    // recovery runs on the default-DS only.
    { provide: recoveryToken, useExisting: StartupRecoveryService },

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
 * Registered only when the default DS itself is registered via a
 * `forRoot`/`forRootAsync` call. Preserves the historical contract
 * where `module.get(EventPublicationRegistry)` and
 * `@Inject(EVENT_PUBLICATION_REPOSITORY)` resolve to the
 * single-dataSource instance.
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
    { provide: StalenessMonitor, useExisting: perDsStalenessMonitorToken(ds) },
    { provide: OUTBOX_PROCESSOR_OPTIONS, useExisting: perDsProcessorOptionsToken(ds) },
    { provide: OUTBOX_STALENESS_CONFIG, useExisting: perDsStalenessConfigToken(ds) },
    { provide: OUTBOX_RECOVERY_OPTIONS, useExisting: perDsRecoveryOptionsToken(ds) },
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
    OUTBOX_PROCESSOR_OPTIONS,
    OUTBOX_STALENESS_CONFIG,
    OUTBOX_RECOVERY_OPTIONS,
  ];
}

/**
 * Build the providers that register the smart facade publisher and
 * the {@link OUTBOX_DATA_SOURCE_NAMES} value provider that carries a
 * live reference to {@link OutboxModule.registrations}. The facade
 * itself uses {@link OnModuleInit} to late-bind per-DS publishers /
 * event-type registries via `ModuleRef` — by the time `OnModuleInit`
 * fires, every per-DS provider across every `forRoot` has been
 * instantiated.
 */
function buildFacadePublisherProvider(moduleClass: typeof OutboxModule): Provider[] {
  return [
    OutboxEventPublisher,
    {
      provide: OUTBOX_DATA_SOURCE_NAMES,
      useValue: privateRegistrations(moduleClass),
    },
  ];
}

/**
 * Build the providers wiring the {@link MultiDsOutboxListenerRegistrar}
 * (Phase 14.3.1). Registered in the first-registration block so the
 * cqrs package's `IntegrationEventsHandlerScanner` picks the smart
 * registrar up via its `@Optional() @Inject(OUTBOX_LISTENER_REGISTRAR)`
 * — without any consumer-side wiring. The structural-port token
 * binding goes through {@link OUTBOX_LISTENER_REGISTRAR_TOKEN}
 * (a `Symbol.for(...)` whose key matches cqrs's
 * `OUTBOX_LISTENER_REGISTRAR`) so neither package imports from the
 * other (Convention #8).
 *
 * Class-token registration (`MultiDsOutboxListenerRegistrar` itself)
 * is preserved alongside the alias so tests and advanced consumers
 * can resolve the registrar by class as well.
 */
function buildMultiDsRegistrarProviders(): Provider[] {
  return [
    MultiDsOutboxListenerRegistrar,
    {
      provide: OUTBOX_LISTENER_REGISTRAR_TOKEN,
      useExisting: MultiDsOutboxListenerRegistrar,
    },
  ];
}

/**
 * Build the {@link OUTBOX_PROCESSING_BUNDLE} provider. Same late-bind
 * via `OnModuleInit` pattern: the bundle is materialised as an empty
 * shape at injection time, then {@link OutboxProcessingModule}
 * resolves per-DS processors / monitors / recovery services from
 * `ModuleRef` in its lifecycle hook.
 */
function buildProcessingBundleProvider(moduleClass: typeof OutboxModule): Provider {
  return {
    provide: OUTBOX_PROCESSING_BUNDLE,
    useFactory: (moduleRef: ModuleRef): OutboxProcessingBundle => {
      const dsNames = Array.from(privateRegistrations(moduleClass).keys());
      // Resolve lazily by capturing dsNames + moduleRef in closure. The
      // OutboxProcessingModule's lifecycle hooks call .start() / .stop()
      // on each entry — by the time those run, every per-DS provider
      // has been instantiated and resolvable via ModuleRef.
      const get = <T>(token: string): T => moduleRef.get<T>(token, { strict: false });
      return {
        get processors(): readonly EventPublicationProcessor[] {
          return dsNames.map((ds) =>
            get<EventPublicationProcessor>(getEventPublicationProcessorToken(ds)),
          );
        },
        get monitors(): readonly StalenessMonitor[] {
          return dsNames.map((ds) => get<StalenessMonitor>(perDsStalenessMonitorToken(ds)));
        },
        get recoveryServices(): readonly StartupRecoveryService[] {
          return dsNames.map((ds) =>
            get<StartupRecoveryService>(perDsStartupRecoveryToken(ds)),
          );
        },
      };
    },
    inject: [ModuleRef],
  };
}

/**
 * Read the private static `registrations` Map from outside the class.
 * The Map is `private` so external code can't mutate it, but our own
 * factories living in this file need read access. By the time these
 * factories run (lazily, at provider-resolution time), every
 * synchronous `forRoot` body has populated the Map.
 *
 * @internal
 */
function privateRegistrations(
  moduleClass: typeof OutboxModule,
): Map<string, OutboxRegistrationRecord> {
  return (moduleClass as unknown as { registrations: Map<string, OutboxRegistrationRecord> })
    .registrations;
}

// `TransactionManager` referenced for documentation completeness;
// no longer used directly in this file after Phase 14.3 (the per-DS
// publisher pushes hooks directly onto the active-transaction object,
// bypassing manager.registerBeforeCommit's single-tx assumption).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _txManagerRef = TransactionManager;
