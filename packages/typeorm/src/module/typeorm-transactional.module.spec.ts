import { Global, Module, type Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  ADAPTER_REGISTRY,
  type AdapterRegistry,
  TransactionalModule,
  getTransactionalAdapterToken,
} from '@nestjs-transactional/core';
import { DataSource } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../adapter/typeorm.adapter';

import { TypeOrmTransactionalModule } from './typeorm-transactional.module';

async function createSqlJsDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'sqljs',
    synchronize: false,
    entities: [],
  });
  await ds.initialize();
  return ds;
}

/**
 * In production the `getDataSourceToken(name)` provider is supplied
 * by `@nestjs/typeorm`'s `TypeOrmModule.forRoot(...)`, which
 * registers it as `@Global()` so child modules (like
 * `TypeOrmTransactionalModule`) can inject it. For these unit
 * tests we replicate that visibility with a tiny `@Global()`
 * fixture module.
 */
function buildFakeDataSourceModule(providers: Provider[]): unknown {
  @Global()
  @Module({
    providers,
    exports: providers.map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p)),
  })
  class FakeDataSourceModule {}
  return FakeDataSourceModule;
}

/**
 * Phase 14.20 module reshape — `forFeature` was renamed to
 * `forRoot` and the options shape changed (dataSource is now a
 * string name, not the DataSource instance). The DataSource
 * itself is resolved via `@nestjs/typeorm`'s `getDataSourceToken`.
 */
describe('TypeOrmTransactionalModule.forRoot', () => {
  let ds: DataSource;

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();
    ds = await createSqlJsDataSource();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('registers a typeorm adapter under the default instance name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildFakeDataSourceModule([{ provide: getDataSourceToken(), useValue: ds }]) as any,
        TransactionalModule.forRoot({ isGlobal: true }),
        TypeOrmTransactionalModule.forRoot(),
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
    const adapter = registry.get('typeorm', 'default');
    expect(adapter).toBeInstanceOf(TypeOrmTransactionAdapter);
    expect(adapter.name).toBe('typeorm');

    // Per-DS adapter token also wired for direct DI access.
    expect(moduleRef.get(getTransactionalAdapterToken('default'))).toBe(adapter);

    await moduleRef.close();
  });

  it('registers a non-default adapter under the supplied dataSource name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        buildFakeDataSourceModule([
          { provide: getDataSourceToken('custom'), useValue: ds },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
        TransactionalModule.forRoot({ isGlobal: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'custom' }),
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
    expect(registry.get('typeorm', 'custom')).toBeInstanceOf(TypeOrmTransactionAdapter);
    expect(moduleRef.get(getTransactionalAdapterToken('custom'))).toBeInstanceOf(
      TypeOrmTransactionAdapter,
    );

    await moduleRef.close();
  });

  it('marks the adapter as the default registry entry when isDefault is true', async () => {
    const other = await createSqlJsDataSource();
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          buildFakeDataSourceModule([
            { provide: getDataSourceToken('primary'), useValue: ds },
            { provide: getDataSourceToken('billing'), useValue: other },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ]) as any,
          TransactionalModule.forRoot({ isGlobal: true }),
          TypeOrmTransactionalModule.forRoot({ dataSource: 'primary' }),
          TypeOrmTransactionalModule.forRoot({ dataSource: 'billing', isDefault: true }),
        ],
      }).compile();
      await moduleRef.init();

      const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
      expect(registry.getDefaultInstanceName()).toBe('billing');

      await moduleRef.close();
    } finally {
      await other.destroy();
    }
  });

  it('forRootAsync registers an adapter via async-resolved options', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        buildFakeDataSourceModule([
          { provide: getDataSourceToken('async-ds'), useValue: ds },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ]) as any,
        TransactionalModule.forRoot({ isGlobal: true }),
        TypeOrmTransactionalModule.forRootAsync({
          useFactory: async () => {
            await Promise.resolve();
            return { dataSource: 'async-ds', isDefault: true };
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
    expect(registry.get('typeorm', 'async-ds')).toBeInstanceOf(TypeOrmTransactionAdapter);
    expect(registry.getDefaultInstanceName()).toBe('async-ds');

    await moduleRef.close();
  });
});
