import { DataSource, type EntityManager } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../../src/adapter/typeorm.adapter';
import { TestUser } from '../shared/test-user.entity';

async function createSqlJsDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'sqljs',
    synchronize: true,
    entities: [TestUser],
  });
  await ds.initialize();
  return ds;
}

describe('TypeOrmTransactionAdapter (unit, SQLite in-memory)', () => {
  let ds: DataSource;
  let adapter: TypeOrmTransactionAdapter;

  beforeEach(async () => {
    ds = await createSqlJsDataSource();
    adapter = new TypeOrmTransactionAdapter(ds, 'default');
  });

  afterEach(async () => {
    await ds.destroy();
  });

  describe('runInTransaction', () => {
    it('commits saved entities on success — readable through the DataSource', async () => {
      await adapter.runInTransaction({}, async (handle) => {
        await handle.entityManager.save(TestUser, { name: 'alice' });
      });

      const users = await ds.getRepository(TestUser).find();
      expect(users.map((u) => u.name)).toEqual(['alice']);
    });

    it('rolls back and rethrows when the callback throws — entity not persisted', async () => {
      const boom = new Error('boom');

      await expect(
        adapter.runInTransaction({}, async (handle) => {
          await handle.entityManager.save(TestUser, { name: 'alice' });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(await ds.getRepository(TestUser).count()).toBe(0);
    });

    it('provides a transactional EntityManager (distinct from DataSource.manager)', async () => {
      await adapter.runInTransaction({}, async (handle) => {
        expect(handle.entityManager).not.toBe(ds.manager);
        expect(handle.entityManager.queryRunner).toBeDefined();
        expect(handle.entityManager.queryRunner?.isTransactionActive).toBe(true);
      });
    });

    it('assigns a unique transactionId per call and adapterName is "typeorm"', async () => {
      const ids: string[] = [];

      for (let i = 0; i < 3; i++) {
        await adapter.runInTransaction({}, async (handle) => {
          expect(handle.adapterName).toBe('typeorm');
          expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);
          ids.push(handle.id);
        });
      }

      expect(new Set(ids).size).toBe(3);
    });

    it('forwards the isolation level to DataSource.transaction (underscore → space)', async () => {
      const transactionCalls: Array<[unknown, unknown]> = [];
      const mockDataSource = {
        transaction: (
          isoOrRunner: unknown,
          maybeRunner?: (em: EntityManager) => Promise<unknown>,
        ) => {
          transactionCalls.push([isoOrRunner, maybeRunner]);
          const runner = (
            typeof isoOrRunner === 'function' ? isoOrRunner : maybeRunner
          ) as (em: EntityManager) => Promise<unknown>;
          return runner({
            query: (): Promise<unknown> => Promise.resolve([]),
          } as unknown as EntityManager);
        },
      } as unknown as DataSource;

      const mockAdapter = new TypeOrmTransactionAdapter(mockDataSource, 'default');

      await mockAdapter.runInTransaction({ isolation: 'READ_COMMITTED' }, async () => 'ok');
      expect(transactionCalls[0]?.[0]).toBe('READ COMMITTED');

      await mockAdapter.runInTransaction({ isolation: 'SERIALIZABLE' }, async () => 'ok');
      expect(transactionCalls[1]?.[0]).toBe('SERIALIZABLE');

      await mockAdapter.runInTransaction({}, async () => 'ok');
      // No-isolation path invokes the single-arg overload: first arg is the runner function.
      expect(typeof transactionCalls[2]?.[0]).toBe('function');
      expect(transactionCalls[2]?.[1]).toBeUndefined();
    });
  });

  describe('runInSavepoint', () => {
    it('releases the savepoint on success — inner writes persist', async () => {
      await adapter.runInTransaction({}, async (parent) => {
        await adapter.runInSavepoint(parent, async () => {
          await parent.entityManager.save(TestUser, { name: 'inner' });
        });
      });

      const users = await ds.getRepository(TestUser).find();
      expect(users.map((u) => u.name)).toEqual(['inner']);
    });

    it('rolls back the savepoint on error — parent transaction continues and commits', async () => {
      await adapter.runInTransaction({}, async (parent) => {
        await parent.entityManager.save(TestUser, { name: 'outer-before' });

        await expect(
          adapter.runInSavepoint(parent, async () => {
            await parent.entityManager.save(TestUser, { name: 'inside-doomed' });
            throw new Error('savepoint boom');
          }),
        ).rejects.toThrow('savepoint boom');

        await parent.entityManager.save(TestUser, { name: 'outer-after' });
      });

      const names = (await ds.getRepository(TestUser).find()).map((u) => u.name).sort();
      expect(names).toEqual(['outer-after', 'outer-before']);
    });

    it('supports nested savepoints (savepoint within savepoint)', async () => {
      await adapter.runInTransaction({}, async (parent) => {
        await parent.entityManager.save(TestUser, { name: 'level-0' });

        await adapter.runInSavepoint(parent, async () => {
          await parent.entityManager.save(TestUser, { name: 'level-1' });

          await adapter.runInSavepoint(parent, async () => {
            await parent.entityManager.save(TestUser, { name: 'level-2' });
          });
        });
      });

      const names = (await ds.getRepository(TestUser).find()).map((u) => u.name).sort();
      expect(names).toEqual(['level-0', 'level-1', 'level-2']);
    });

    it('rolling back a middle savepoint preserves outer levels', async () => {
      await adapter.runInTransaction({}, async (parent) => {
        await parent.entityManager.save(TestUser, { name: 'outer' });

        await adapter.runInSavepoint(parent, async () => {
          await parent.entityManager.save(TestUser, { name: 'middle' });

          await expect(
            adapter.runInSavepoint(parent, async () => {
              await parent.entityManager.save(TestUser, { name: 'inner-doomed' });
              throw new Error('inner boom');
            }),
          ).rejects.toThrow('inner boom');
        });
      });

      const names = (await ds.getRepository(TestUser).find()).map((u) => u.name).sort();
      expect(names).toEqual(['middle', 'outer']);
    });
  });
});
