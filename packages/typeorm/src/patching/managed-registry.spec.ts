import { TransactionContext } from '@nestjs-transactional/core';
import { DataSource, EntityManager } from 'typeorm';

import type { TypeOrmTransactionHandle } from '../types/typeorm-transaction-handle';

import {
  getActiveEntityManager,
  getManagedDataSourceName,
  isManaged,
  markAsManaged,
  resetManagedRegistry,
} from './managed-registry';
import { TYPEORM_DATA_SOURCE_NAME } from './symbols';

async function createSqlJsDataSource(): Promise<DataSource> {
  const ds = new DataSource({ type: 'sqljs', synchronize: false, entities: [] });
  await ds.initialize();
  return ds;
}

describe('managed-registry', () => {
  afterEach(() => {
    resetManagedRegistry();
  });

  describe('markAsManaged + isManaged + getManagedDataSourceName', () => {
    it('stamps the dataSource name and reports membership', async () => {
      const ds = await createSqlJsDataSource();
      try {
        expect(isManaged(ds)).toBe(false);
        markAsManaged(ds, 'billing');
        expect(isManaged(ds)).toBe(true);
        expect(getManagedDataSourceName(ds)).toBe('billing');
      } finally {
        await ds.destroy();
      }
    });

    it('uses the correct Symbol.for() namespaced key for the stamp', async () => {
      const ds = await createSqlJsDataSource();
      try {
        markAsManaged(ds, 'inventory');
        // Verify the stamp lands on the well-known Symbol so the
        // patches in repository-patches / data-source-patches read
        // the same key.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((ds as any)[TYPEORM_DATA_SOURCE_NAME]).toBe('inventory');
        expect(TYPEORM_DATA_SOURCE_NAME).toBe(
          Symbol.for('@nestjs-transactional/typeorm/data-source-name'),
        );
      } finally {
        await ds.destroy();
      }
    });

    it('non-managed DataSource is not in the registry and has no stamp', async () => {
      const ds = await createSqlJsDataSource();
      try {
        expect(isManaged(ds)).toBe(false);
        expect(getManagedDataSourceName(ds)).toBeUndefined();
      } finally {
        await ds.destroy();
      }
    });

    it('resetManagedRegistry drops every managed entry', async () => {
      const ds = await createSqlJsDataSource();
      try {
        markAsManaged(ds, 'default');
        expect(isManaged(ds)).toBe(true);
        resetManagedRegistry();
        expect(isManaged(ds)).toBe(false);
        // The stamp survives — documented trade-off. Tests that
        // care recreate the DataSource between cases.
        expect(getManagedDataSourceName(ds)).toBe('default');
      } finally {
        await ds.destroy();
      }
    });
  });

  describe('getActiveEntityManager', () => {
    it('returns undefined outside any transactional scope', () => {
      expect(getActiveEntityManager('default')).toBeUndefined();
    });

    it('returns the EntityManager from the active TransactionContext entry', async () => {
      // Build an ActiveTransaction by hand and install it under the
      // composite key TransactionManager would write to.
      // EntityManager constructor needs a DataSource — use sqljs.
      const ds = await createSqlJsDataSource();
      try {
        const fakeEm = new EntityManager(ds);
        const handle: TypeOrmTransactionHandle = {
          id: 'test-tx',
          adapterName: 'typeorm',
          entityManager: fakeEm,
        };

        await TransactionContext.run('corr-1', async () => {
          TransactionContext.setActiveTransaction('typeorm:default', {
            handle,
            adapterName: 'typeorm',
            adapterInstanceName: 'default',
            options: {},
            startedAt: new Date(),
            afterCommitHooks: [],
            afterRollbackHooks: [],
            beforeCommitHooks: [],
            correlationId: 'corr-1',
          });

          const active = getActiveEntityManager('default');
          expect(active).toBe(fakeEm);
        });
      } finally {
        await ds.destroy();
      }
    });
  });
});
