import { type DynamicModule, Module } from '@nestjs/common';
import { ADAPTER_REGISTRY, AdapterRegistry } from '@nestjs-transactional/core';
import type { DataSource } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../adapter/typeorm.adapter';

/**
 * Options accepted by {@link TypeOrmTransactionalModule.forFeature}.
 *
 * The dataSource identifier and the actual TypeORM `DataSource` instance
 * are two distinct concepts here, and they live in two distinct fields:
 *
 *  - `dataSourceName` — the *string identifier* used everywhere across
 *    `@nestjs-transactional` (e.g. `@Transactional({ dataSource: 'billing' })`,
 *    `getCurrentEntityManager('billing')`, the `AdapterRegistry` lookup).
 *  - `dataSource` — the *actual TypeORM `DataSource` instance* (or a
 *    factory returning one). Distinct field name retained because it
 *    has been the public contract since the package was introduced.
 *
 * See ADR-018's "Vocabulary asymmetry" note for why two terms are
 * preserved despite the surface inconsistency.
 */
export interface TypeOrmTransactionalOptions {
  /**
   * Identifier under which this TypeORM dataSource is registered with
   * the core {@link AdapterRegistry}. Defaults to `'default'`. Use
   * distinct names for multi-datasource setups (`'billing'`,
   * `'inventory'`, ...).
   *
   * Aligns with the `dataSourceName` property exposed by
   * {@link TransactionalAdapter} (Phase 14.2) — the same string flows
   * through `@Transactional({ dataSource })`, `getCurrentEntityManager`,
   * and the adapter registry.
   */
  readonly dataSourceName?: string;

  /**
   * DataSource to bind, either directly or through a factory. The factory
   * allows async resolution (e.g. reading from configuration) and runs
   * once at module-init time.
   *
   * Note: this is the *DataSource instance*, not its identifier. The
   * identifier lives in {@link dataSourceName}.
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
 *       dataSourceName: 'billing',
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
    const dataSourceName = options.dataSourceName ?? 'default';
    const providerToken = `TYPEORM_ADAPTER_${dataSourceName}`;

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

            const adapter = new TypeOrmTransactionAdapter(ds, dataSourceName);
            registry.register(
              { adapterName: 'typeorm', instanceName: dataSourceName, adapter },
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
