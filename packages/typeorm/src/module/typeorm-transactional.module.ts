import { type DynamicModule, Module } from '@nestjs/common';
import { ADAPTER_REGISTRY, AdapterRegistry } from '@nestjs-transactional/core';
import type { DataSource } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../adapter/typeorm.adapter';

/**
 * Options accepted by {@link TypeOrmTransactionalModule.forFeature}.
 */
export interface TypeOrmTransactionalOptions {
  /**
   * Adapter instance name under which this TypeORM DataSource is
   * registered with the core {@link AdapterRegistry}. Defaults to
   * `'default'`. Use distinct names for multi-datasource setups
   * (`'primary'`, `'billing'`, ...).
   */
  readonly instanceName?: string;

  /**
   * DataSource to bind, either directly or through a factory. The factory
   * allows async resolution (e.g. reading from configuration) and runs
   * once at module-init time.
   */
  readonly dataSource: DataSource | (() => Promise<DataSource> | DataSource);

  /**
   * Mark this instance as the default adapter in the registry, even if
   * it is not the first registered.
   */
  readonly isDefault?: boolean;
}

/**
 * NestJS module that binds a TypeORM {@link DataSource} to the core
 * {@link AdapterRegistry} as an adapter instance. Import once per
 * DataSource:
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forFeature({ dataSource: primaryDs }),
 *     TypeOrmTransactionalModule.forFeature({
 *       instanceName: 'billing',
 *       dataSource: () => billingDs,
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Requires `TransactionalModule.forRoot({ isGlobal: true })` — the core
 * module provides the `AdapterRegistry` this module writes into, and
 * `isGlobal: true` is needed so that the registry is visible inside
 * `TypeOrmTransactionalModule`'s provider scope.
 */
@Module({})
export class TypeOrmTransactionalModule {
  static forFeature(options: TypeOrmTransactionalOptions): DynamicModule {
    const instanceName = options.instanceName ?? 'default';
    const providerToken = `TYPEORM_ADAPTER_${instanceName}`;

    return {
      module: TypeOrmTransactionalModule,
      providers: [
        {
          provide: providerToken,
          useFactory: async (registry: AdapterRegistry): Promise<TypeOrmTransactionAdapter> => {
            const ds =
              typeof options.dataSource === 'function'
                ? await options.dataSource()
                : options.dataSource;

            const adapter = new TypeOrmTransactionAdapter(ds, instanceName);
            registry.register(
              { adapterName: 'typeorm', instanceName, adapter },
              options.isDefault ?? false,
            );
            return adapter;
          },
          inject: [ADAPTER_REGISTRY],
        },
      ],
    };
  }
}
