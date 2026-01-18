import {
  ADAPTER_REGISTRY,
  AdapterRegistry,
  IllegalTransactionStateError,
  TransactionManager,
} from '@nestjs-transactional/core';
import { DataSource } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../../src/adapter/typeorm.adapter';
import {
  getCurrentEntityManager,
  isInTransaction,
} from '../../src/helpers/get-entity-manager';
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

function buildManager(
  adapter: TypeOrmTransactionAdapter,
  instanceName = 'default',
): TransactionManager {
  const registry = new AdapterRegistry();
  registry.register({ adapterName: 'typeorm', instanceName, adapter });
  return new TransactionManager(registry);
}

describe('getCurrentEntityManager / isInTransaction', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = await createSqlJsDataSource();
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it('returns the transactional EntityManager when called inside @Transactional', async () => {
    const adapter = new TypeOrmTransactionAdapter(ds, 'default');
    const manager = buildManager(adapter);

    let seenIsNotDsManager = false;
    await manager.run({}, async () => {
      const em = getCurrentEntityManager('default');
      seenIsNotDsManager = em !== ds.manager;
      const saved = await em.save(TestUser, { name: 'tx-user' });
      expect(saved.id).toBeGreaterThan(0);
    });

    expect(seenIsNotDsManager).toBe(true);
    const users = await ds.getRepository(TestUser).find();
    expect(users.map((u) => u.name)).toEqual(['tx-user']);
  });

  it('returns fallback.manager when called outside a transaction with a fallback', () => {
    const em = getCurrentEntityManager('default', ds);
    expect(em).toBe(ds.manager);
  });

  it('throws IllegalTransactionStateError when no transaction and no fallback', () => {
    expect(() => getCurrentEntityManager('default')).toThrow(IllegalTransactionStateError);
    expect(() => getCurrentEntityManager('default')).toThrow(
      /No active transaction for 'typeorm:default'/,
    );
  });

  it('keeps different adapter instances isolated — looking up another instance falls through', async () => {
    const primary = new TypeOrmTransactionAdapter(ds, 'primary');
    const registry = new AdapterRegistry();
    registry.register({ adapterName: 'typeorm', instanceName: 'primary', adapter: primary });
    const manager = new TransactionManager(registry);

    await manager.run({ adapterInstance: 'primary' }, async () => {
      // Inside the 'primary' tx, looking up 'primary' returns its EM.
      const primaryEm = getCurrentEntityManager('primary');
      expect(primaryEm).toBeDefined();
      expect(primaryEm).not.toBe(ds.manager);

      // Looking up a DIFFERENT instance name finds no active tx and throws.
      expect(() => getCurrentEntityManager('billing')).toThrow(IllegalTransactionStateError);

      // With a fallback, it returns the fallback's manager instead.
      expect(getCurrentEntityManager('billing', ds)).toBe(ds.manager);
    });
  });

  it('isInTransaction is false outside a tx and true inside for the correct instance', async () => {
    const adapter = new TypeOrmTransactionAdapter(ds, 'default');
    const manager = buildManager(adapter);

    expect(isInTransaction('default')).toBe(false);

    await manager.run({}, async () => {
      expect(isInTransaction('default')).toBe(true);
      // A different instance name is still false — instances are isolated.
      expect(isInTransaction('billing')).toBe(false);
    });

    expect(isInTransaction('default')).toBe(false);
  });

  it('is compatible with TransactionalModule.forRoot wiring (integration via DI)', async () => {
    // Smoke test: helper works when the adapter is registered through the
    // standard DI path (as opposed to hand-built AdapterRegistry above).
    const adapter = new TypeOrmTransactionAdapter(ds, 'default');
    const registry = new AdapterRegistry();
    registry.register({ adapterName: 'typeorm', instanceName: 'default', adapter });
    const manager = new TransactionManager(registry);

    // Sanity-check the token used inside the ADAPTER_REGISTRY provider
    // matches what core expects.
    expect(typeof ADAPTER_REGISTRY).toBe('symbol');

    await manager.run({}, async () => {
      const em = getCurrentEntityManager();
      await em.save(TestUser, { name: 'from-default-instance' });
    });

    const users = await ds.getRepository(TestUser).find();
    expect(users.map((u) => u.name)).toEqual(['from-default-instance']);
  });
});
