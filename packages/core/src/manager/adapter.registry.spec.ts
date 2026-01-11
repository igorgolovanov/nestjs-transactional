import { TransactionAdapterNotFoundError } from '../types/errors';
import type { TransactionAdapter } from '../types/transaction-adapter';

import { AdapterRegistry, type AdapterRegistration } from './adapter.registry';

function makeAdapter(name = 'mock'): TransactionAdapter {
  return {
    name,
    runInTransaction: jest.fn(),
    runInSavepoint: jest.fn(),
  };
}

function makeRegistration(overrides: Partial<AdapterRegistration> = {}): AdapterRegistration {
  return {
    adapterName: 'mock',
    instanceName: 'default',
    adapter: makeAdapter(),
    ...overrides,
  };
}

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;

  beforeEach(() => {
    registry = new AdapterRegistry();
  });

  describe('register + get', () => {
    it('stores an adapter and returns it by (adapterName, instanceName)', () => {
      const adapter = makeAdapter('typeorm');
      const registration = makeRegistration({
        adapterName: 'typeorm',
        instanceName: 'primary',
        adapter,
      });

      registry.register(registration);

      expect(registry.get('typeorm', 'primary')).toBe(adapter);
    });

    it('keys registrations by (adapterName, instanceName) — distinct pairs do not collide', () => {
      const typeorm = makeAdapter('typeorm');
      const prisma = makeAdapter('prisma');

      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'primary', adapter: typeorm }),
      );
      registry.register(
        makeRegistration({ adapterName: 'prisma', instanceName: 'primary', adapter: prisma }),
      );

      expect(registry.get('typeorm', 'primary')).toBe(typeorm);
      expect(registry.get('prisma', 'primary')).toBe(prisma);
    });
  });

  describe('default adapter selection', () => {
    it('marks the first registered adapter as default automatically', () => {
      registry.register(makeRegistration({ adapterName: 'typeorm', instanceName: 'primary' }));

      expect(registry.getDefaultAdapterName()).toBe('typeorm');
      expect(registry.getDefaultInstanceName()).toBe('primary');
    });

    it('keeps the first default after more registrations without isDefault', () => {
      registry.register(makeRegistration({ adapterName: 'typeorm', instanceName: 'primary' }));
      registry.register(makeRegistration({ adapterName: 'typeorm', instanceName: 'billing' }));
      registry.register(makeRegistration({ adapterName: 'prisma', instanceName: 'reporting' }));

      expect(registry.getDefaultAdapterName()).toBe('typeorm');
      expect(registry.getDefaultInstanceName()).toBe('primary');
    });

    it('explicit isDefault=true on a later registration overrides the current default', () => {
      registry.register(makeRegistration({ adapterName: 'typeorm', instanceName: 'primary' }));
      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'billing' }),
        true,
      );

      expect(registry.getDefaultAdapterName()).toBe('typeorm');
      expect(registry.getDefaultInstanceName()).toBe('billing');
    });

    it('explicit isDefault=true on the first registration leaves it as default', () => {
      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'primary' }),
        true,
      );

      expect(registry.getDefaultAdapterName()).toBe('typeorm');
      expect(registry.getDefaultInstanceName()).toBe('primary');
    });
  });

  describe('error paths', () => {
    it('get() on an unknown (adapterName, instanceName) pair throws TransactionAdapterNotFoundError', () => {
      expect(() => registry.get('typeorm', 'primary')).toThrow(TransactionAdapterNotFoundError);
    });

    it('the TransactionAdapterNotFoundError message includes both adapterName and instanceName', () => {
      try {
        registry.get('typeorm', 'ghost');
        throw new Error('expected throw, got return');
      } catch (err) {
        expect(err).toBeInstanceOf(TransactionAdapterNotFoundError);
        const e = err as TransactionAdapterNotFoundError;
        expect(e.message).toContain('typeorm');
        expect(e.message).toContain('ghost');
        expect(e.code).toBe('TRANSACTION_ADAPTER_NOT_FOUND');
      }
    });

    it('getDefaultAdapterName() without any registrations throws an error that mentions registration', () => {
      expect(() => registry.getDefaultAdapterName()).toThrow(/regist/i);
    });

    it('getDefaultInstanceName() returns "default" before any registrations (initial field value)', () => {
      expect(registry.getDefaultInstanceName()).toBe('default');
    });
  });

  describe('multi-instance of the same adapter type', () => {
    it('returns the correct adapter for each instance of the same adapter type', () => {
      const primary = makeAdapter('typeorm');
      const billing = makeAdapter('typeorm');

      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'primary', adapter: primary }),
      );
      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'billing', adapter: billing }),
      );

      expect(registry.get('typeorm', 'primary')).toBe(primary);
      expect(registry.get('typeorm', 'billing')).toBe(billing);
    });
  });

  describe('duplicate registration', () => {
    it('re-registering the same pair overwrites the previously stored adapter', () => {
      const first = makeAdapter('typeorm');
      const second = makeAdapter('typeorm');

      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'primary', adapter: first }),
      );
      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'primary', adapter: second }),
      );

      expect(registry.get('typeorm', 'primary')).toBe(second);
    });

    it('re-registering the current default pair does not lose default status', () => {
      const first = makeAdapter('typeorm');
      const second = makeAdapter('typeorm');

      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'primary', adapter: first }),
      );
      registry.register(
        makeRegistration({ adapterName: 'typeorm', instanceName: 'primary', adapter: second }),
      );

      expect(registry.getDefaultAdapterName()).toBe('typeorm');
      expect(registry.getDefaultInstanceName()).toBe('primary');
      expect(registry.get('typeorm', 'primary')).toBe(second);
    });
  });

  describe('getAll', () => {
    it('returns an empty array when nothing is registered', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('returns all registrations after multiple register() calls', () => {
      const r1 = makeRegistration({ adapterName: 'typeorm', instanceName: 'primary' });
      const r2 = makeRegistration({ adapterName: 'typeorm', instanceName: 'billing' });
      const r3 = makeRegistration({ adapterName: 'prisma', instanceName: 'reporting' });

      registry.register(r1);
      registry.register(r2);
      registry.register(r3);

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      expect(all).toEqual(expect.arrayContaining([r1, r2, r3]));
    });
  });
});
