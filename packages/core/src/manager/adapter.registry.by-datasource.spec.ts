import { IllegalTransactionStateError, TransactionAdapterNotFoundError } from '../types/errors';
import type { TransactionAdapter } from '../types/transaction-adapter';

import { AdapterRegistry } from './adapter.registry';

function makeAdapter(name = 'mock', dataSourceName = 'default'): TransactionAdapter {
  return {
    name,
    dataSourceName,
    runInTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
  };
}

describe('AdapterRegistry.getByDataSource', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it('returns the adapter registered under the given dataSource name', () => {
    const billingAdapter = makeAdapter('typeorm', 'billing');
    registry.register({
      adapterName: 'typeorm',
      instanceName: 'billing',
      adapter: billingAdapter,
    });

    expect(registry.getByDataSource('billing')).toBe(billingAdapter);
  });

  it('discriminates between distinct dataSources of the same adapter type', () => {
    const billing = makeAdapter('typeorm', 'billing');
    const inventory = makeAdapter('typeorm', 'inventory');
    registry.register({ adapterName: 'typeorm', instanceName: 'billing', adapter: billing });
    registry.register({ adapterName: 'typeorm', instanceName: 'inventory', adapter: inventory });

    expect(registry.getByDataSource('billing')).toBe(billing);
    expect(registry.getByDataSource('inventory')).toBe(inventory);
  });

  it('throws TransactionAdapterNotFoundError when no adapter matches', () => {
    expect(() => registry.getByDataSource('absent')).toThrow(TransactionAdapterNotFoundError);
  });

  it('throws IllegalTransactionStateError when two adapter types share the same dataSource name', () => {
    registry.register({
      adapterName: 'typeorm',
      instanceName: 'billing',
      adapter: makeAdapter('typeorm', 'billing'),
    });
    registry.register({
      adapterName: 'prisma',
      instanceName: 'billing',
      adapter: makeAdapter('prisma', 'billing'),
    });

    expect(() => registry.getByDataSource('billing')).toThrow(IllegalTransactionStateError);
    expect(() => registry.getByDataSource('billing')).toThrow(/Multiple adapters registered/);
  });
});

describe('AdapterRegistry.getAdapterNameByDataSource', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  it('returns the adapter type name for a registered dataSource', () => {
    registry.register({
      adapterName: 'typeorm',
      instanceName: 'billing',
      adapter: makeAdapter('typeorm', 'billing'),
    });

    expect(registry.getAdapterNameByDataSource('billing')).toBe('typeorm');
  });

  it('throws when no adapter matches', () => {
    expect(() => registry.getAdapterNameByDataSource('absent')).toThrow(
      TransactionAdapterNotFoundError,
    );
  });

  it('throws on ambiguous dataSource name', () => {
    registry.register({
      adapterName: 'typeorm',
      instanceName: 'billing',
      adapter: makeAdapter('typeorm', 'billing'),
    });
    registry.register({
      adapterName: 'prisma',
      instanceName: 'billing',
      adapter: makeAdapter('prisma', 'billing'),
    });

    expect(() => registry.getAdapterNameByDataSource('billing')).toThrow(
      IllegalTransactionStateError,
    );
  });
});
