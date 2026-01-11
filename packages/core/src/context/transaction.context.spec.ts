import { IllegalTransactionStateError } from '../types/errors';
import type { TransactionHandle } from '../types/transaction-handle';

import {
  TransactionContext,
  type ActiveTransaction,
  type TransactionContextStore,
} from './transaction.context';

function makeActiveTx(
  adapterInstanceName: string,
  overrides: Partial<ActiveTransaction> = {},
): ActiveTransaction {
  const handle: TransactionHandle = { id: `h-${adapterInstanceName}`, adapterName: 'test' };
  return {
    handle,
    adapterName: 'test',
    adapterInstanceName,
    options: {},
    startedAt: new Date(),
    afterCommitHooks: [],
    afterRollbackHooks: [],
    beforeCommitHooks: [],
    correlationId: 'corr',
    ...overrides,
  };
}

describe('TransactionContext', () => {
  describe('run()', () => {
    it('creates a store that fn can read via getStore()', async () => {
      await TransactionContext.run('corr-1', async () => {
        expect(TransactionContext.getStore()).toBeDefined();
      });
    });

    it('returns the value resolved by fn', async () => {
      const result = await TransactionContext.run('corr-1', async () => 42);
      expect(result).toBe(42);
    });

    it('returns undefined from getStore() outside of run()', () => {
      expect(TransactionContext.getStore()).toBeUndefined();
    });

    it('initialises the store with correlationId, empty activeTransactions, and startedAt near now', async () => {
      const before = Date.now();
      await TransactionContext.run('corr-abc', async () => {
        const store = TransactionContext.getStore();
        expect(store).toBeDefined();
        expect(store!.correlationId).toBe('corr-abc');
        expect(store!.activeTransactions).toBeInstanceOf(Map);
        expect(store!.activeTransactions.size).toBe(0);
        expect(store!.startedAt).toBeInstanceOf(Date);
        expect(store!.startedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(store!.startedAt.getTime()).toBeLessThanOrEqual(Date.now());
      });
    });

    it('reuses the existing store on nested run() — correlationId stays that of the outer scope', async () => {
      await TransactionContext.run('outer', async () => {
        const outerStore = TransactionContext.getStore();
        expect(outerStore?.correlationId).toBe('outer');

        await TransactionContext.run('inner', async () => {
          const innerStore = TransactionContext.getStore();
          expect(innerStore).toBe(outerStore);
          expect(innerStore?.correlationId).toBe('outer');
        });

        expect(TransactionContext.getStore()).toBe(outerStore);
      });
    });

    it('isolates parallel run() calls — each gets its own store and correlationId', async () => {
      const results = await Promise.all([
        TransactionContext.run('parallel-1', async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return TransactionContext.getStore()?.correlationId;
        }),
        TransactionContext.run('parallel-2', async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return TransactionContext.getStore()?.correlationId;
        }),
        TransactionContext.run('parallel-3', async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return TransactionContext.getStore()?.correlationId;
        }),
      ]);

      expect(results).toEqual(['parallel-1', 'parallel-2', 'parallel-3']);
    });

    it('propagates the store across await boundaries', async () => {
      await TransactionContext.run('across-await', async () => {
        const before = TransactionContext.getStore();

        await new Promise((resolve) => setTimeout(resolve, 5));

        const after = TransactionContext.getStore();
        expect(after).toBe(before);
        expect(after?.correlationId).toBe('across-await');

        await Promise.resolve();
        const afterMicrotask = TransactionContext.getStore();
        expect(afterMicrotask).toBe(before);
      });
    });

    it('propagates the store into callbacks scheduled from fn (setImmediate)', async () => {
      await TransactionContext.run('across-setImmediate', async () => {
        const outerStore = TransactionContext.getStore();
        const scheduled = await new Promise<TransactionContextStore | undefined>((resolve) => {
          setImmediate(() => {
            resolve(TransactionContext.getStore());
          });
        });
        expect(scheduled).toBe(outerStore);
      });
    });
  });

  describe('active transactions', () => {
    it('round-trips a transaction via setActiveTransaction + getActiveTransaction', async () => {
      await TransactionContext.run('corr', async () => {
        const tx = makeActiveTx('primary');
        TransactionContext.setActiveTransaction('primary', tx);
        expect(TransactionContext.getActiveTransaction('primary')).toBe(tx);
      });
    });

    it('supports multiple active transactions keyed by adapterInstanceName', async () => {
      await TransactionContext.run('corr', async () => {
        const primary = makeActiveTx('primary');
        const billing = makeActiveTx('billing');

        TransactionContext.setActiveTransaction('primary', primary);
        TransactionContext.setActiveTransaction('billing', billing);

        expect(TransactionContext.getActiveTransaction('primary')).toBe(primary);
        expect(TransactionContext.getActiveTransaction('billing')).toBe(billing);
        expect(TransactionContext.getStore()?.activeTransactions.size).toBe(2);
      });
    });

    it('returns undefined from getActiveTransaction() for an unknown instance name', async () => {
      await TransactionContext.run('corr', async () => {
        expect(TransactionContext.getActiveTransaction('nope')).toBeUndefined();
      });
    });

    it('removeActiveTransaction removes only the named transaction', async () => {
      await TransactionContext.run('corr', async () => {
        const primary = makeActiveTx('primary');
        const billing = makeActiveTx('billing');

        TransactionContext.setActiveTransaction('primary', primary);
        TransactionContext.setActiveTransaction('billing', billing);

        TransactionContext.removeActiveTransaction('primary');

        expect(TransactionContext.getActiveTransaction('primary')).toBeUndefined();
        expect(TransactionContext.getActiveTransaction('billing')).toBe(billing);
        expect(TransactionContext.getStore()?.activeTransactions.size).toBe(1);
      });
    });

    it('setActiveTransaction outside of run() throws IllegalTransactionStateError', () => {
      expect(() =>
        TransactionContext.setActiveTransaction('primary', makeActiveTx('primary')),
      ).toThrow(IllegalTransactionStateError);
    });

    it('beforeCommitHooks / afterCommitHooks / afterRollbackHooks are mutable arrays', async () => {
      await TransactionContext.run('corr', async () => {
        TransactionContext.setActiveTransaction('primary', makeActiveTx('primary'));
        const stored = TransactionContext.getActiveTransaction('primary');
        expect(stored).toBeDefined();

        const before: () => Promise<void> = async () => {};
        const after: () => Promise<void> = async () => {};
        const rollback: (error: unknown) => Promise<void> = async () => {};

        stored!.beforeCommitHooks.push(before);
        stored!.afterCommitHooks.push(after);
        stored!.afterRollbackHooks.push(rollback);

        expect(stored!.beforeCommitHooks).toEqual([before]);
        expect(stored!.afterCommitHooks).toEqual([after]);
        expect(stored!.afterRollbackHooks).toEqual([rollback]);
      });
    });
  });
});
