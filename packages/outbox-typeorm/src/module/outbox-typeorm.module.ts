import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { EVENT_PUBLICATION_REPOSITORY } from '@nestjs-transactional/outbox-core';
import type { DataSource } from 'typeorm';

import { TypeOrmEventPublicationRepository } from '../repository/typeorm-event-publication.repository';
import {
  DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
  SCHEMA_INITIALIZATION_OPTIONS,
  type SchemaInitializationOptions,
} from '../schema/schema-initialization-options';
import { SchemaInitializer } from '../schema/schema-initializer';

/**
 * Options accepted by {@link OutboxTypeOrmModule.forFeature}.
 */
export interface OutboxTypeOrmOptions {
  /**
   * Adapter instance name the repository binds to — matches the
   * `instanceName` used when registering the TypeORM transaction
   * adapter with `TypeOrmTransactionalModule.forFeature`. Defaults to
   * `'default'`.
   */
  readonly adapterInstance?: string;

  /**
   * DataSource to persist publications into. Accept either a direct
   * instance (the common case) or a thunk / async thunk for late
   * initialisation (e.g. a DataSource produced by an async factory in
   * another module). The thunk runs once — the resolved DataSource is
   * cached across the repository and schema-initializer providers.
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

const OUTBOX_TYPEORM_DATA_SOURCE = Symbol('OUTBOX_TYPEORM_DATA_SOURCE');

/**
 * NestJS module that wires the TypeORM persistence backend for the
 * Event Publication Registry. Provides:
 *
 * - {@link TypeOrmEventPublicationRepository} (bound to the configured
 *   DataSource and adapter instance) — exported so
 *   {@link typeOrmEventPublicationRepositoryProvider} can alias it to
 *   `EVENT_PUBLICATION_REPOSITORY` in `OutboxModule.forRoot`.
 * - {@link SchemaInitializer} — a no-op unless `schemaInitialization`
 *   is enabled; see its JSDoc for the development-only contract.
 *
 * Typical wiring, in order:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forFeature({ dataSource }),
 *     OutboxTypeOrmModule.forFeature({ dataSource }),
 *     OutboxModule.forRoot({
 *       eventTypes: [OrderPlacedEvent],
 *       repository: typeOrmEventPublicationRepositoryProvider,
 *     }),
 *     OutboxProcessingModule, // only in worker processes
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class OutboxTypeOrmModule {
  static forFeature(options: OutboxTypeOrmOptions): DynamicModule {
    const adapterInstance = options.adapterInstance ?? 'default';

    const providers: Provider[] = [
      {
        provide: OUTBOX_TYPEORM_DATA_SOURCE,
        useFactory: async (): Promise<DataSource> =>
          typeof options.dataSource === 'function'
            ? await options.dataSource()
            : options.dataSource,
      },
      {
        provide: TypeOrmEventPublicationRepository,
        useFactory: (ds: DataSource): TypeOrmEventPublicationRepository =>
          new TypeOrmEventPublicationRepository(ds, adapterInstance),
        inject: [OUTBOX_TYPEORM_DATA_SOURCE],
      },
      {
        provide: SCHEMA_INITIALIZATION_OPTIONS,
        useValue: options.schemaInitialization ?? DEFAULT_SCHEMA_INITIALIZATION_OPTIONS,
      },
      {
        provide: SchemaInitializer,
        useFactory: (ds: DataSource, opts: SchemaInitializationOptions): SchemaInitializer =>
          new SchemaInitializer(ds, opts),
        inject: [OUTBOX_TYPEORM_DATA_SOURCE, SCHEMA_INITIALIZATION_OPTIONS],
      },
    ];

    return {
      module: OutboxTypeOrmModule,
      global: options.isGlobal ?? true,
      providers,
      exports: [TypeOrmEventPublicationRepository, SchemaInitializer, SCHEMA_INITIALIZATION_OPTIONS],
    };
  }
}

/**
 * Provider spec that aliases `EVENT_PUBLICATION_REPOSITORY` (the token
 * `OutboxModule` and its downstream consumers inject) to the TypeORM
 * repository registered by {@link OutboxTypeOrmModule.forFeature}.
 *
 * Pass to `OutboxModule.forRoot({ repository: ... })` — this prevents
 * `OutboxModule` from installing its InMemory default, which otherwise
 * collides with the TypeORM implementation at the
 * `EVENT_PUBLICATION_REPOSITORY` token.
 */
export const typeOrmEventPublicationRepositoryProvider: Provider = {
  provide: EVENT_PUBLICATION_REPOSITORY,
  useExisting: TypeOrmEventPublicationRepository,
};
