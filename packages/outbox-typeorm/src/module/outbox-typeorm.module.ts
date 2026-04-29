import {
  type DynamicModule,
  type FactoryProvider,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EVENT_PUBLICATION_REPOSITORY } from '@nestjs-transactional/outbox';
import type { DataSource } from 'typeorm';

import { TypeOrmEventPublicationRepository } from '../repository/typeorm-event-publication.repository';
import {
  DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
  type SchemaInitializationOptions,
} from '../schema/schema-initialization-options';
import { SchemaInitializer } from '../schema/schema-initializer';

/**
 * Options accepted by {@link OutboxTypeOrmModule.forRoot} (Phase 14.21).
 *
 * The dataSource identifier is now a *string name only*. The actual
 * `DataSource` instance is resolved from DI under
 * `getDataSourceToken(name)` — the same convention `@nestjs/typeorm`
 * uses for `@InjectRepository(E, dataSource)`. Mirrors the Phase 14.20
 * shape of `TypeOrmTransactionalModule.forRoot`.
 */
export interface OutboxTypeOrmOptions {
  /**
   * Identifier of the dataSource the repository binds to. Aligns with
   * `TypeOrmTransactionalModule.forRoot({ dataSource })` and the
   * `@Transactional({ dataSource })` decorator option. Defaults to
   * `'default'`.
   *
   * Multi-dataSource deployments call `forRoot` once per dataSource;
   * each call registers its own `TypeOrmEventPublicationRepository`
   * instance under {@link getTypeOrmRepositoryProviderToken} so the
   * outbox-side per-DS tokens (Phase 14.3) can resolve them via the
   * provider returned by {@link typeOrmEventPublicationRepositoryProvider}.
   */
  readonly dataSource?: string;

  /**
   * Development-only auto-schema-creation config. Defaults to
   * `{ enabled: false }`. When enabled, {@link SchemaInitializer} will
   * create `event_publication` and `event_publication_archive` on
   * application bootstrap if they are missing. Production deployments
   * should apply the shipped TypeORM migration instead.
   */
  readonly schemaInitialization?: SchemaInitializationOptions;

  /**
   * Register as a `@Global()` module so exports are visible to
   * `OutboxModule` and the rest of the application without an explicit
   * import chain. Defaults to `true` — the typical deployment imports
   * `OutboxTypeOrmModule.forRoot` once in the root module and
   * expects the repository to be globally resolvable.
   */
  readonly isGlobal?: boolean;
}

/**
 * Asynchronous flavour of {@link OutboxTypeOrmOptions}. Mirrors the
 * shape of `TypeOrmTransactionalModule.forRootAsync` (Phase 14.20).
 *
 * **dataSource name limitation**: the `dataSource` field on this
 * interface is *statically declared* (not async-resolved). NestJS
 * provider tokens must be declared at module-build time, and
 * per-DS tokens like `getTypeOrmRepositoryProviderToken(name)`
 * require the name synchronously. The async factory resolves only
 * the remaining config (`schemaInitialization`, `isGlobal`). If
 * fully-async dataSource-name resolution is required, pre-resolve
 * the name in your own bootstrap code and call sync `forRoot`
 * with the result.
 */
export interface OutboxTypeOrmAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Statically-known dataSource name (see {@link OutboxTypeOrmAsyncOptions}
   * JSDoc for the rationale). Defaults to `'default'`.
   */
  readonly dataSource?: string;

  /**
   * Async factory resolving the *remaining* options (excluding
   * `dataSource` which must be static).
   */
  readonly useFactory: (
    ...args: never[]
  ) =>
    | Promise<Omit<OutboxTypeOrmOptions, 'dataSource'>>
    | Omit<OutboxTypeOrmOptions, 'dataSource'>;

  readonly inject?: readonly InjectionToken[];
}

/**
 * Private per-dataSource token under which {@link OutboxTypeOrmModule}
 * registers the `TypeOrmEventPublicationRepository` instance for a
 * given dataSource. Internal — consumed only by
 * {@link typeOrmEventPublicationRepositoryProvider} via `useExisting`,
 * which the user feeds into `OutboxModule.forRoot({ repository })` (one
 * `forRoot` call per dataSource — ADR-019 multi-forRoot pattern).
 */
export function getTypeOrmRepositoryProviderToken(dataSourceName: string): string {
  return `OUTBOX_TYPEORM_REPOSITORY_${dataSourceName}`;
}

/**
 * Internal per-dataSource token for the {@link SchemaInitializer}
 * instance bound to a given dataSource. Each `forRoot` call
 * instantiates its own initializer (NestJS lifecycle invokes
 * `onApplicationBootstrap` on every registered instance) so the
 * `event_publication` schema is created in each configured dataSource
 * independently.
 */
function getOutboxTypeOrmSchemaInitializerToken(dataSourceName: string): string {
  return `OUTBOX_TYPEORM_SCHEMA_INITIALIZER_${dataSourceName}`;
}

/**
 * Internal per-dataSource token carrying the resolved
 * {@link SchemaInitializationOptions} the matching
 * {@link SchemaInitializer} reads on bootstrap. Distinct from the
 * package-level `SCHEMA_INITIALIZATION_OPTIONS` symbol exported by
 * `../schema/schema-initialization-options` — that symbol stays
 * exported for users who wire `SchemaInitializer` manually outside
 * `OutboxTypeOrmModule.forRoot`.
 */
function getOutboxTypeOrmSchemaOptionsToken(dataSourceName: string): string {
  return `OUTBOX_TYPEORM_SCHEMA_OPTIONS_${dataSourceName}`;
}

const ASYNC_OPTIONS_TOKEN = (id: number): symbol =>
  Symbol(`OUTBOX_TYPEORM_ASYNC_OPTIONS[${id}]`);

/**
 * NestJS module that wires the TypeORM persistence backend for the
 * Event Publication Registry (Phase 14.21 reshape, mirrors Phase
 * 14.20's `TypeOrmTransactionalModule.forRoot`). Multi-dataSource
 * setups call {@link forRoot} once per dataSource — each call
 * registers an independent {@link TypeOrmEventPublicationRepository}
 * instance under a private per-dataSource token. The
 * {@link typeOrmEventPublicationRepositoryProvider} factory returns
 * a `Provider` that aliases the outbox-side per-DS repository token
 * to that private token.
 *
 * The actual `DataSource` is resolved via `@nestjs/typeorm`'s
 * `getDataSourceToken(name)` — `TypeOrmModule.forRoot(...)` registers
 * it globally, so this module just looks it up in DI.
 *
 * Single-dataSource wiring:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ ... }),
 *
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forRoot(),
 *
 *     OutboxModule.forRoot({
 *       repository: typeOrmEventPublicationRepositoryProvider(),
 *     }),
 *     OutboxTypeOrmModule.forRoot(),
 *     OutboxModule.forFeature([OrderPlacedEvent]),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Multi-dataSource wiring:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ ... }),
 *     TypeOrmModule.forRoot({ name: 'billing', ... }),
 *
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forRoot(),
 *     TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),
 *
 *     OutboxModule.forRoot({
 *       repository: typeOrmEventPublicationRepositoryProvider(),
 *     }),
 *     OutboxModule.forRoot({
 *       dataSource: 'billing',
 *       repository: typeOrmEventPublicationRepositoryProvider('billing'),
 *     }),
 *
 *     OutboxTypeOrmModule.forRoot(),
 *     OutboxTypeOrmModule.forRoot({ dataSource: 'billing' }),
 *
 *     OutboxModule.forFeature([DefaultEvent], { dataSource: 'default' }),
 *     OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class OutboxTypeOrmModule {
  /**
   * @internal
   * Counter for `forRootAsync`-only token uniqueness. Mirrors the
   * pattern used in `TypeOrmTransactionalModule.forRootAsync`
   * (Phase 14.20) — every async call gets a unique provider symbol
   * so consecutive calls don't collide.
   */
  private static asyncCounter = 0;

  /**
   * Test-only — reset the async-counter so tests building multiple
   * modules sequentially don't accumulate symbol IDs in a single
   * Jest worker. Production code should never call this.
   *
   * @internal
   */
  static resetForTesting(): void {
    this.asyncCounter = 0;
  }

  /**
   * Synchronous registration. Each call binds one DataSource (by
   * name) to the outbox-typeorm infrastructure: registers the
   * repository under the private per-DS token, registers the
   * per-DS `SchemaInitializer`, and resolves the actual `DataSource`
   * via `@nestjs/typeorm`'s `getDataSourceToken(name)`.
   *
   * @example Default DataSource
   * ```ts
   * OutboxTypeOrmModule.forRoot()
   * ```
   *
   * @example Named DataSource
   * ```ts
   * OutboxTypeOrmModule.forRoot({ dataSource: 'billing' })
   * ```
   */
  static forRoot(options: OutboxTypeOrmOptions = {}): DynamicModule {
    const dataSourceName = options.dataSource ?? 'default';

    const providers = buildPerDataSourceProviders(dataSourceName, {
      schemaInitializationProvider: {
        provide: getOutboxTypeOrmSchemaOptionsToken(dataSourceName),
        useValue: options.schemaInitialization ?? DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
      },
    });

    return {
      module: OutboxTypeOrmModule,
      global: options.isGlobal ?? true,
      providers,
      exports: buildPerDataSourceExports(dataSourceName),
    };
  }

  /**
   * Asynchronous registration. The `dataSource` name is statically
   * declared (see {@link OutboxTypeOrmAsyncOptions} for the
   * rationale); the `useFactory` resolves the remaining options
   * (`schemaInitialization`, `isGlobal`) through a NestJS-style
   * async factory.
   *
   * @example
   * ```ts
   * OutboxTypeOrmModule.forRootAsync({
   *   dataSource: 'billing',
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => ({
   *     schemaInitialization: { enabled: cfg.get('NODE_ENV') !== 'production' },
   *   }),
   * });
   * ```
   */
  static forRootAsync(options: OutboxTypeOrmAsyncOptions): DynamicModule {
    const dataSourceName = options.dataSource ?? 'default';
    const id = this.asyncCounter++;
    const asyncOptionsToken = ASYNC_OPTIONS_TOKEN(id);

    const asyncOptionsProvider: FactoryProvider = {
      provide: asyncOptionsToken,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };

    const schemaOptionsProvider: FactoryProvider = {
      provide: getOutboxTypeOrmSchemaOptionsToken(dataSourceName),
      useFactory: (
        resolved: Omit<OutboxTypeOrmOptions, 'dataSource'>,
      ): SchemaInitializationOptions =>
        resolved.schemaInitialization ?? DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
      inject: [asyncOptionsToken],
    };

    const providers = [
      asyncOptionsProvider,
      ...buildPerDataSourceProviders(dataSourceName, {
        schemaInitializationProvider: schemaOptionsProvider,
      }),
    ];

    return {
      module: OutboxTypeOrmModule,
      global: true,
      imports: options.imports ?? [],
      providers,
      exports: buildPerDataSourceExports(dataSourceName),
    };
  }
}

/**
 * Common per-dataSource provider construction shared between
 * `forRoot` (sync schema-options provider) and `forRootAsync`
 * (async-resolved schema-options provider). The repository and
 * SchemaInitializer providers are shape-identical between the two
 * paths; only the schema-options provider's mechanics differ
 * (sync `useValue` vs async `useFactory`), which is why it's
 * passed in.
 */
function buildPerDataSourceProviders(
  dataSourceName: string,
  args: { schemaInitializationProvider: Provider },
): Provider[] {
  const dataSourceToken = getDataSourceToken(dataSourceName);
  const repositoryToken = getTypeOrmRepositoryProviderToken(dataSourceName);
  const schemaInitializerToken = getOutboxTypeOrmSchemaInitializerToken(dataSourceName);
  const schemaOptionsToken = getOutboxTypeOrmSchemaOptionsToken(dataSourceName);

  return [
    {
      provide: repositoryToken,
      useFactory: (ds: DataSource): TypeOrmEventPublicationRepository =>
        new TypeOrmEventPublicationRepository(ds, dataSourceName),
      inject: [dataSourceToken],
    },
    args.schemaInitializationProvider,
    {
      provide: schemaInitializerToken,
      useFactory: (ds: DataSource, opts: SchemaInitializationOptions): SchemaInitializer =>
        new SchemaInitializer(ds, opts),
      inject: [dataSourceToken, schemaOptionsToken],
    },
  ];
}

function buildPerDataSourceExports(dataSourceName: string): InjectionToken[] {
  return [
    getTypeOrmRepositoryProviderToken(dataSourceName),
    getOutboxTypeOrmSchemaInitializerToken(dataSourceName),
    getOutboxTypeOrmSchemaOptionsToken(dataSourceName),
  ];
}

/**
 * Factory returning a `Provider` that aliases the outbox-side per-DS
 * repository token (`getEventPublicationRepositoryToken(dataSourceName)`)
 * to the `TypeOrmEventPublicationRepository` instance registered by
 * {@link OutboxTypeOrmModule.forRoot} for the same dataSource.
 *
 * **Why this bridge function exists** (frequently-asked question, full
 * explanation):
 *
 * `OutboxModule.forRoot` ALWAYS registers something under the per-DS
 * `getEventPublicationRepositoryToken(dataSourceName)` token — when no
 * `repository` option is passed, it defaults to
 * `InMemoryEventPublicationRepository`. `OutboxTypeOrmModule.forRoot`
 * cannot register under THE SAME token directly because both modules
 * are `@Global()` and a duplicate `@Global()` provider for the same
 * token causes NestJS DI conflicts.
 *
 * The bridge function side-steps the conflict by registering an
 * `useExisting` alias provider in `OutboxModule`'s scope:
 * `OutboxModule.forRoot({ repository: typeOrmEventPublicationRepositoryProvider() })`
 * tells `OutboxModule` "for this dataSource's repository, alias to the
 * private token under which `OutboxTypeOrmModule.forRoot` registered
 * its `TypeOrmEventPublicationRepository` instance". `OutboxModule`'s
 * `reBindProvider` machinery overwrites the placeholder `provide`
 * field with the per-DS expected token; the `useExisting` clause
 * carries the actual aliasing.
 *
 * Net flow at runtime:
 *
 * ```
 * @InjectEventPublicationRepository → getEventPublicationRepositoryToken('billing')
 *   → useExisting → getTypeOrmRepositoryProviderToken('billing')   // private
 *   → TypeOrmEventPublicationRepository instance
 * ```
 *
 * Phase 14.21 considered removing this bridge function (delete it,
 * have `OutboxTypeOrmModule.forRoot` register directly under the
 * official outbox-side token), but the change would require
 * `OutboxModule.forRoot` to drop its in-memory default — which would
 * break 14+ outbox unit tests that rely on `OutboxModule.forRoot({})`
 * defaulting to in-memory. The bridge function is small and
 * well-documented; keeping it preserves the architectural separation
 * (outbox-core does not import outbox-typeorm) and saves the test
 * migration burden.
 *
 * Usage — pass to `OutboxModule.forRoot({ repository })`. Multi-DS
 * setups call `forRoot` once per dataSource (ADR-019 multi-forRoot
 * pattern) with the corresponding alias-provider call:
 *
 * ```ts
 * // Single-DS
 * OutboxModule.forRoot({
 *   repository: typeOrmEventPublicationRepositoryProvider(),
 * })
 *
 * // Multi-DS — one forRoot per dataSource
 * OutboxModule.forRoot({
 *   repository: typeOrmEventPublicationRepositoryProvider(),
 * })
 * OutboxModule.forRoot({
 *   dataSource: 'billing',
 *   repository: typeOrmEventPublicationRepositoryProvider('billing'),
 * })
 * ```
 *
 * The returned provider's `provide` field is a placeholder
 * (`EVENT_PUBLICATION_REPOSITORY`) — outbox's `reBindProvider`
 * overwrites it with the per-DS token. The substantive part is the
 * `useExisting` clause, which resolves to the private per-DS token
 * registered by `forRoot`.
 */
export function typeOrmEventPublicationRepositoryProvider(
  dataSourceName = 'default',
): Provider {
  return {
    provide: EVENT_PUBLICATION_REPOSITORY,
    useExisting: getTypeOrmRepositoryProviderToken(dataSourceName),
  };
}
