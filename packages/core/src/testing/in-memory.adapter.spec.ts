import type { TransactionOptions } from '../types/transaction-options';

import { InMemoryTransactionAdapter, type InMemoryTransactionHandle } from './in-memory.adapter';

describe('InMemoryTransactionAdapter', () => {
  let adapter: InMemoryTransactionAdapter;

  beforeEach(() => {
    adapter = new InMemoryTransactionAdapter();
  });

  describe('runInTransaction', () => {
    it('records a committed transaction on success and returns the value', async () => {
      const options: TransactionOptions = { isolation: 'READ_COMMITTED', readOnly: false };

      const result = await adapter.runInTransaction(options, async (handle) => {
        handle.operations.push('insert user');
        handle.operations.push('insert profile');
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);

      const committed = adapter.committedTransactions[0];
      expect(committed).toBeDefined();
      expect(committed!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(committed!.operations).toEqual(['insert user', 'insert profile']);
      expect(committed!.options).toBe(options);
    });

    it('records a rolled-back transaction on error and rethrows', async () => {
      const options: TransactionOptions = { readOnly: true };
      const boom = new Error('boom');

      await expect(
        adapter.runInTransaction(options, async (handle) => {
          handle.operations.push('attempted read');
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(adapter.committedTransactions).toHaveLength(0);
      expect(adapter.rolledBackTransactions).toHaveLength(1);

      const rolled = adapter.rolledBackTransactions[0];
      expect(rolled).toBeDefined();
      expect(rolled!.operations).toEqual(['attempted read']);
      expect(rolled!.options).toBe(options);
      expect(rolled!.error).toBe(boom);
    });

    it('assigns a distinct handle id per invocation', async () => {
      await adapter.runInTransaction({}, async () => 1);
      await adapter.runInTransaction({}, async () => 2);

      const [first, second] = adapter.committedTransactions;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first!.id).not.toBe(second!.id);
    });

    it('exposes the handle.adapterName matching the adapter name', async () => {
      let seenAdapterName: string | undefined;
      await adapter.runInTransaction({}, async (handle) => {
        seenAdapterName = handle.adapterName;
      });
      expect(seenAdapterName).toBe(adapter.name);
    });
  });

  describe('runInSavepoint', () => {
    const makeParent = (id = 'parent-1'): InMemoryTransactionHandle => ({
      id,
      adapterName: 'in-memory',
      operations: [],
    });

    it('records savepointsCreated and savepointsReleased on success', async () => {
      const parent = makeParent('parent-1');

      const result = await adapter.runInSavepoint(parent, async () => 'inner');

      expect(result).toBe('inner');
      expect(adapter.savepointsCreated).toHaveLength(1);
      expect(adapter.savepointsReleased).toHaveLength(1);
      expect(adapter.savepointsRolledBack).toHaveLength(0);

      const created = adapter.savepointsCreated[0];
      const released = adapter.savepointsReleased[0];
      expect(created).toBeDefined();
      expect(released).toBeDefined();
      expect(created!.parentId).toBe('parent-1');
      expect(released!.parentId).toBe('parent-1');
      expect(released!.savepointId).toBe(created!.savepointId);
    });

    it('records savepointsCreated and savepointsRolledBack on error and rethrows', async () => {
      const parent = makeParent('parent-2');
      const boom = new Error('sp boom');

      await expect(
        adapter.runInSavepoint(parent, async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(adapter.savepointsCreated).toHaveLength(1);
      expect(adapter.savepointsReleased).toHaveLength(0);
      expect(adapter.savepointsRolledBack).toHaveLength(1);

      const created = adapter.savepointsCreated[0];
      const rolled = adapter.savepointsRolledBack[0];
      expect(created).toBeDefined();
      expect(rolled).toBeDefined();
      expect(rolled!.parentId).toBe('parent-2');
      expect(rolled!.savepointId).toBe(created!.savepointId);
      expect(rolled!.error).toBe(boom);
    });

    it('passes the parent handle unchanged to the callback', async () => {
      const parent = makeParent('parent-3');
      let received: InMemoryTransactionHandle | undefined;

      await adapter.runInSavepoint(parent, async (handle) => {
        received = handle;
      });

      expect(received).toBe(parent);
    });
  });

  describe('reset', () => {
    it('clears every observation array', async () => {
      await adapter.runInTransaction({}, async () => 1);
      await adapter
        .runInTransaction({}, async () => {
          throw new Error('x');
        })
        .catch(() => undefined);

      const parent: InMemoryTransactionHandle = {
        id: 'parent',
        adapterName: 'in-memory',
        operations: [],
      };
      await adapter.runInSavepoint(parent, async () => 'ok');
      await adapter
        .runInSavepoint(parent, async () => {
          throw new Error('y');
        })
        .catch(() => undefined);

      expect(adapter.committedTransactions.length).toBeGreaterThan(0);
      expect(adapter.rolledBackTransactions.length).toBeGreaterThan(0);
      expect(adapter.savepointsCreated.length).toBeGreaterThan(0);
      expect(adapter.savepointsReleased.length).toBeGreaterThan(0);
      expect(adapter.savepointsRolledBack.length).toBeGreaterThan(0);

      adapter.reset();

      expect(adapter.committedTransactions).toEqual([]);
      expect(adapter.rolledBackTransactions).toEqual([]);
      expect(adapter.savepointsCreated).toEqual([]);
      expect(adapter.savepointsReleased).toEqual([]);
      expect(adapter.savepointsRolledBack).toEqual([]);
    });
  });
});
