import { Test } from '@nestjs/testing';
import {
  ADAPTER_REGISTRY,
  type AdapterRegistry,
  TransactionalModule,
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

describe('TypeOrmTransactionalModule.forFeature', () => {
  let ds: DataSource;

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    ds = await createSqlJsDataSource();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('registers a typeorm adapter under the default instance name', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({ isGlobal: true }),
        TypeOrmTransactionalModule.forFeature({ dataSource: ds }),
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
    const adapter = registry.get('typeorm', 'default');
    expect(adapter).toBeInstanceOf(TypeOrmTransactionAdapter);
    expect(adapter.name).toBe('typeorm');

    await moduleRef.close();
  });

  it('accepts an async dataSource factory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({ isGlobal: true }),
        TypeOrmTransactionalModule.forFeature({
          dataSource: () => Promise.resolve(ds),
          dataSourceName: 'custom',
        }),
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
    expect(registry.get('typeorm', 'custom')).toBeInstanceOf(TypeOrmTransactionAdapter);

    await moduleRef.close();
  });

  it('marks the adapter as the default registry entry when isDefault is true', async () => {
    const other = await createSqlJsDataSource();
    try {
      const moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({ isGlobal: true }),
          TypeOrmTransactionalModule.forFeature({
            dataSource: ds,
            dataSourceName: 'primary',
          }),
          TypeOrmTransactionalModule.forFeature({
            dataSource: other,
            dataSourceName: 'billing',
            isDefault: true,
          }),
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
});
