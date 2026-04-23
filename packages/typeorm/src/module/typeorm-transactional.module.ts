import { type DynamicModule, Inject, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { ADAPTER_REGISTRY, AdapterRegistry } from '@nestjs-transactional/core';
import type { DataSource } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../adapter/typeorm.adapter';

/**
 * Options accepted by {@link TypeOrmTransactionalModule.forFeature}.
 */
export interface TypeOrmTransactionalModuleOptions {
  /**
   * Adapter instance name under which this TypeORM DataSource is
   * registered with the core {@link AdapterRegistry}. Defaults to
   * `'default'`. Use distinct names when registering multiple
   * DataSources (e.g. `'primary'`, `'billing'`).
   */
  readonly instanceName?: string;

  /**
   * DataSource to bind, either directly or through a factory. A factory
   * allows async resolution (e.g. reading from config) and is invoked
   * once at module init time.
   */
  readonly dataSource: DataSource | (() => Promise<DataSource> | DataSource);

  /**
   * Mark this instance as the default adapter in the registry, even if
   * it is not the first registered.
   */
  readonly isDefault?: boolean;
}

const TYPEORM_ADAPTER_OPTIONS = Symbol('TYPEORM_TRANSACTIONAL_ADAPTER_OPTIONS');

interface ResolvedOptions {
  readonly instanceName: string;
  readonly dataSource: DataSource;
  readonly isDefault: boolean;
}

/**
 * Internal service that runs at module init to register the adapter with
 * the core {@link AdapterRegistry}. Implemented as a provider with
 * `OnModuleInit` rather than a raw `useFactory` side effect so that the
 * DataSource-factory resolution happens lazily (before tests / app code
 * touches the registry) and is visible in the DI graph.
 */
@Injectable()
class TypeOrmAdapterRegistrar implements OnModuleInit {
  constructor(
    @Inject(TYPEORM_ADAPTER_OPTIONS)
    private readonly options: ResolvedOptions,
    @Inject(ADAPTER_REGISTRY)
    private readonly registry: AdapterRegistry,
  ) {}

  onModuleInit(): void {
    const adapter = new TypeOrmTransactionAdapter(
      this.options.dataSource,
      this.options.instanceName,
    );
    this.registry.register(
      {
        adapterName: 'typeorm',
        instanceName: this.options.instanceName,
        adapter,
      },
      this.options.isDefault,
    );
  }
}

/**
 * NestJS module that binds a TypeORM {@link DataSource} to the core
 * {@link AdapterRegistry} as an adapter instance. Import once per
 * DataSource in your application:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot(),
 *     TypeOrmTransactionalModule.forFeature({ dataSource: primaryDs }),
 *     TypeOrmTransactionalModule.forFeature({
 *       instanceName: 'billing',
 *       dataSource: billingDs,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Requires `TransactionalModule.forRoot()` (or `forRootAsync`) to be
 * imported alongside — the core module provides the
 * {@link AdapterRegistry} instance this module registers against.
 */
@Module({})
export class TypeOrmTransactionalModule {
  static forFeature(options: TypeOrmTransactionalModuleOptions): DynamicModule {
    const resolvedOptionsProvider = {
      provide: TYPEORM_ADAPTER_OPTIONS,
      useFactory: async (): Promise<ResolvedOptions> => ({
        instanceName: options.instanceName ?? 'default',
        dataSource:
          typeof options.dataSource === 'function'
            ? await options.dataSource()
            : options.dataSource,
        isDefault: options.isDefault ?? false,
      }),
    };

    return {
      module: TypeOrmTransactionalModule,
      providers: [resolvedOptionsProvider, TypeOrmAdapterRegistrar],
    };
  }
}
