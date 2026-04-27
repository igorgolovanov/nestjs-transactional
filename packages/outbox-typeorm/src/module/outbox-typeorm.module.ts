import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { EVENT_PUBLICATION_REPOSITORY } from '@nestjs-transactional/outbox';
import type { DataSource } from 'typeorm';

import { TypeOrmEventPublicationRepository } from '../repository/typeorm-event-publication.repository';
import {
  DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
  type SchemaInitializationOptions,
} from '../schema/schema-initialization-options';
import { SchemaInitializer } from '../schema/schema-initializer';

/**
 * Options accepted by {@link OutboxTypeOrmModule.forFeature}.
 *
 * The dataSource identifier and the actual TypeORM `DataSource` instance
 * are two distinct concepts here, and they live in two distinct fields:
 *
 *  - `dataSourceName` — the *string identifier* used everywhere across
 *    `@nestjs-transactional` (e.g. `@Transactional({ dataSource: 'billing' })`,
 *    `getCurrentEntityManager('billing')`, the `AdapterRegistry` lookup,
 *    Phase 14.3's outbox per-DS tokens).
 *  - `dataSource` — the *actual TypeORM `DataSource` instance* (or a
 *    factory returning one).
 *
 * See ADR-018's "Vocabulary asymmetry" note for why two terms are
 * preserved despite the surface inconsistency.
 */
export interface OutboxTypeOrmOptions {
  /**
   * Identifier of the dataSource the repository binds to. Aligns with
   * `TypeOrmTransactionalModule.forFeature({ dataSourceName })` and the
   * `@Transactional({ dataSource })` decorator option. Defaults to
   * `'default'`.
   *
   * Multi-dataSource deployments call `forFeature` once per dataSource;
   * each call registers its own `TypeOrmEventPublicationRepository`
   * instance under {@link getTypeOrmRepositoryProviderToken} so the
   * outbox-side per-DS tokens (Phase 14.3) can resolve them via the
   * provider returned by {@link typeOrmEventPublicationRepositoryProvider}.
   */
  readonly dataSourceName?: string;

  /**
   * @deprecated Use {@link dataSourceName} — kept as a permanent alias
   * for backwards compatibility. When both are set, `dataSourceName`
   * wins. Removal deferred to a future major version.
   */
  readonly adapterInstance?: string;

  /**
   * DataSource to persist publications into. Accept either a direct
   * instance (the common case) or a thunk / async thunk for late
   * initialisation (e.g. a DataSource produced by an async factory in
   * another module). The thunk runs once — the resolved DataSource is
   * cached across the repository and schema-initializer providers.
   *
   * Note: this is the *DataSource instance*, not its identifier. The
   * identifier lives in {@link dataSourceName}.
   */
  readonly dataSource: DataSource | (() => Promise<DataSource> | DataSource);

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
   * `OutboxTypeOrmModule.forFeature` once in the root module and
   * expects the repository to be globally resolvable.
   */
  readonly isGlobal?: boolean;
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
 * Internal per-dataSource token under which {@link OutboxTypeOrmModule}
 * registers the resolved TypeORM `DataSource` instance for a given
 * dataSource. The {@link OutboxTypeOrmOptions.dataSource} field accepts
 * either a `DataSource` directly or a (possibly async) factory, and
 * the resolution is cached behind this token so the repository and
 * schema-initializer providers share the same instance.
 *
 * Per-dataSource derivation is what makes multiple `forFeature` calls
 * safe — a single global Symbol would clash across them.
 */
function getOutboxTypeOrmDataSourceToken(dataSourceName: string): string {
  return `OUTBOX_TYPEORM_DATA_SOURCE_${dataSourceName}`;
}

/**
 * Internal per-dataSource token for the {@link SchemaInitializer}
 * instance bound to a given dataSource. Each `forFeature` call
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
 * `OutboxTypeOrmModule.forFeature`.
 */
function getOutboxTypeOrmSchemaOptionsToken(dataSourceName: string): string {
  return `OUTBOX_TYPEORM_SCHEMA_OPTIONS_${dataSourceName}`;
}

/**
 * NestJS module that wires the TypeORM persistence backend for the
 * Event Publication Registry. Multi-dataSource setups call
 * {@link forFeature} once per dataSource — each call registers an
 * independent {@link TypeOrmEventPublicationRepository} instance under
 * a private per-dataSource token. The
 * {@link typeOrmEventPublicationRepositoryProvider} factory returns
 * a `Provider` that aliases the outbox-side per-DS repository token
 * to that private token.
 *
 * Single-dataSource wiring:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forFeature({ dataSource }),
 *     OutboxTypeOrmModule.forFeature({ dataSource }),
 *     OutboxModule.forRoot({
 *       repository: typeOrmEventPublicationRepositoryProvider(),
 *     }),
 *     OutboxModule.forFeature([OrderPlacedEvent]),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Multi-dataSource wiring (Phase 14.5):
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forFeature({ dataSource: defaultDs }),
 *     TypeOrmTransactionalModule.forFeature({
 *       dataSourceName: 'billing',
 *       dataSource: billingDs,
 *     }),
 *     OutboxTypeOrmModule.forFeature({ dataSource: defaultDs }),
 *     OutboxTypeOrmModule.forFeature({
 *       dataSourceName: 'billing',
 *       dataSource: billingDs,
 *     }),
 *     OutboxModule.forRoot({
 *       repository: typeOrmEventPublicationRepositoryProvider(),
 *     }),
 *     OutboxModule.forRoot({
 *       dataSource: 'billing',
 *       repository: typeOrmEventPublicationRepositoryProvider('billing'),
 *     }),
 *     OutboxModule.forFeature([DefaultEvent], { dataSource: 'default' }),
 *     OutboxModule.forFeature([BillingEvent], { dataSource: 'billing' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class OutboxTypeOrmModule {
  static forFeature(options: OutboxTypeOrmOptions): DynamicModule {
    // dataSourceName takes precedence over the deprecated adapterInstance.
    // Both default to 'default' when omitted.
    const dataSourceName = options.dataSourceName ?? options.adapterInstance ?? 'default';

    const dataSourceToken = getOutboxTypeOrmDataSourceToken(dataSourceName);
    const repositoryToken = getTypeOrmRepositoryProviderToken(dataSourceName);
    const schemaInitializerToken = getOutboxTypeOrmSchemaInitializerToken(dataSourceName);
    const schemaOptionsToken = getOutboxTypeOrmSchemaOptionsToken(dataSourceName);

    const providers: Provider[] = [
      {
        provide: dataSourceToken,
        useFactory: async (): Promise<DataSource> =>
          typeof options.dataSource === 'function'
            ? await options.dataSource()
            : options.dataSource,
      },
      {
        provide: repositoryToken,
        useFactory: (ds: DataSource): TypeOrmEventPublicationRepository =>
          new TypeOrmEventPublicationRepository(ds, dataSourceName),
        inject: [dataSourceToken],
      },
      {
        provide: schemaOptionsToken,
        useValue: options.schemaInitialization ?? DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
      },
      {
        provide: schemaInitializerToken,
        useFactory: (ds: DataSource, opts: SchemaInitializationOptions): SchemaInitializer =>
          new SchemaInitializer(ds, opts),
        inject: [dataSourceToken, schemaOptionsToken],
      },
    ];

    return {
      module: OutboxTypeOrmModule,
      global: options.isGlobal ?? true,
      providers,
      exports: [repositoryToken, schemaInitializerToken, schemaOptionsToken],
    };
  }
}

/**
 * Factory returning a `Provider` that aliases the outbox-side per-DS
 * repository token (`getEventPublicationRepositoryToken(dataSourceName)`)
 * to the `TypeOrmEventPublicationRepository` instance registered by
 * {@link OutboxTypeOrmModule.forFeature} for the same dataSource.
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
 * registered by `forFeature`. NestJS sees a single provider per token,
 * so multiple `forFeature` calls coexist without collision.
 *
 * Phase 14.5 changed this from a static const Provider to a function
 * returning a Provider. Migration is mechanical — replace the bare
 * reference with a call: `typeOrmEventPublicationRepositoryProvider`
 * → `typeOrmEventPublicationRepositoryProvider()`.
 */
export function typeOrmEventPublicationRepositoryProvider(
  dataSourceName = 'default',
): Provider {
  return {
    provide: EVENT_PUBLICATION_REPOSITORY,
    useExisting: getTypeOrmRepositoryProviderToken(dataSourceName),
  };
}
