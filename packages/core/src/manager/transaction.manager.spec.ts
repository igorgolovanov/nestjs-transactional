import { TransactionContext } from '../context/transaction.context';
import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter';

import { AdapterRegistry } from './adapter.registry';
import { TransactionManager } from './transaction.manager';

describe('TransactionManager (propagation REQUIRED)', () => {
  let adapter: InMemoryTransactionAdapter;
  let registry: AdapterRegistry;
  let manager: TransactionManager;

  beforeEach(() => {
    adapter = new InMemoryTransactionAdapter();
    registry = new AdapterRegistry();
    registry.register({
      adapterName: 'in-memory',
      instanceName: 'default',
      adapter,
    });
    manager = new TransactionManager(registry);
  });

  describe('transaction lifecycle', () => {
    it('creates a new transaction when none is active', async () => {
      await manager.run({}, async () => {
        // inside the transaction
      });

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
    });

    it('nested run() joins the active transaction — adapter records a single commit', async () => {
      await manager.run({}, async () => {
        await manager.run({}, async () => {
          await manager.run({}, async () => {
            // deeply nested
          });
        });
      });

      expect(adapter.committedTransactions).toHaveLength(1);
    });

    it('returns the value resolved by fn', async () => {
      const result = await manager.run({}, async () => 'hello');
      expect(result).toBe('hello');
    });

    it('rolls back and rethrows when fn throws', async () => {
      const boom = new Error('boom');

      await expect(
        manager.run({}, async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(adapter.committedTransactions).toHaveLength(0);
      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions[0]?.error).toBe(boom);
    });
  });

  describe('hooks', () => {
    it('AFTER_COMMIT hook runs after the adapter commit completes', async () => {
      let committedCountAtHookTime: number | undefined;

      await manager.run({}, async () => {
        manager.registerAfterCommit(async () => {
          committedCountAtHookTime = adapter.committedTransactions.length;
        });
      });

      expect(committedCountAtHookTime).toBe(1);
    });

    it('AFTER_COMMIT hook does not run when the transaction rolls back', async () => {
      let afterCommitRan = false;

      await expect(
        manager.run({}, async () => {
          manager.registerAfterCommit(async () => {
            afterCommitRan = true;
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      expect(afterCommitRan).toBe(false);
    });

    it('AFTER_ROLLBACK hook runs on rollback and receives the thrown error', async () => {
      let receivedError: unknown;
      const boom = new Error('rollback cause');

      await expect(
        manager.run({}, async () => {
          manager.registerAfterRollback(async (err) => {
            receivedError = err;
          });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(receivedError).toBe(boom);
    });

    it('multiple hooks run in registration order', async () => {
      const order: number[] = [];

      await manager.run({}, async () => {
        manager.registerAfterCommit(async () => {
          order.push(1);
        });
        manager.registerAfterCommit(async () => {
          order.push(2);
        });
        manager.registerAfterCommit(async () => {
          order.push(3);
        });
      });

      expect(order).toEqual([1, 2, 3]);
    });

    it('throw inside an AFTER_COMMIT hook does not reject run() (hook errors are swallowed)', async () => {
      await expect(
        manager.run({}, async () => {
          manager.registerAfterCommit(async () => {
            throw new Error('hook failure');
          });
        }),
      ).resolves.toBeUndefined();

      expect(adapter.committedTransactions).toHaveLength(1);
    });

    it('throw in one AFTER_COMMIT hook does not prevent subsequent hooks from running', async () => {
      const ran: number[] = [];

      await manager.run({}, async () => {
        manager.registerAfterCommit(async () => {
          ran.push(1);
        });
        manager.registerAfterCommit(async () => {
          ran.push(2);
          throw new Error('mid failure');
        });
        manager.registerAfterCommit(async () => {
          ran.push(3);
        });
      });

      expect(ran).toEqual([1, 2, 3]);
    });
  });

  describe('correlation id propagation', () => {
    it('nested run() inherits the outer correlationId', async () => {
      let outerCorrelationId: string | undefined;
      let innerCorrelationId: string | undefined;

      await manager.run({}, async () => {
        outerCorrelationId = TransactionContext.getStore()?.correlationId;

        await manager.run({}, async () => {
          innerCorrelationId = TransactionContext.getStore()?.correlationId;
        });
      });

      expect(outerCorrelationId).toBeDefined();
      expect(innerCorrelationId).toBeDefined();
      expect(innerCorrelationId).toBe(outerCorrelationId);
    });
  });

  describe('rollback rules (rollbackFor / noRollbackFor)', () => {
    class BusinessErrorA extends Error {}
    class BusinessErrorB extends Error {}

    it('rolls back and fires afterRollback hooks when the error matches rollbackFor', async () => {
      let afterCommitRan = false;
      let afterRollbackReceived: unknown;
      const boom = new BusinessErrorA('a');

      await expect(
        manager.run({ rollbackFor: [BusinessErrorA] }, async () => {
          manager.registerAfterCommit(async () => {
            afterCommitRan = true;
          });
          manager.registerAfterRollback(async (err) => {
            afterRollbackReceived = err;
          });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(adapter.committedTransactions).toHaveLength(0);
      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(afterCommitRan).toBe(false);
      expect(afterRollbackReceived).toBe(boom);
    });

    it('commits and fires afterCommit hooks when the error does NOT match a specified rollbackFor', async () => {
      let afterCommitRan = false;
      let afterRollbackRan = false;
      const boom = new BusinessErrorB('b');

      await expect(
        manager.run({ rollbackFor: [BusinessErrorA] }, async () => {
          manager.registerAfterCommit(async () => {
            afterCommitRan = true;
          });
          manager.registerAfterRollback(async () => {
            afterRollbackRan = true;
          });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
      expect(afterCommitRan).toBe(true);
      expect(afterRollbackRan).toBe(false);
    });

    it('commits and fires afterCommit hooks when the error matches noRollbackFor', async () => {
      let afterCommitRan = false;
      let afterRollbackRan = false;
      const boom = new BusinessErrorA('a');

      await expect(
        manager.run({ noRollbackFor: [BusinessErrorA] }, async () => {
          manager.registerAfterCommit(async () => {
            afterCommitRan = true;
          });
          manager.registerAfterRollback(async () => {
            afterRollbackRan = true;
          });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
      expect(afterCommitRan).toBe(true);
      expect(afterRollbackRan).toBe(false);
    });

    it('rolls back and fires afterRollback hooks when the error does NOT match noRollbackFor', async () => {
      let afterCommitRan = false;
      let afterRollbackReceived: unknown;
      const boom = new BusinessErrorB('b');

      await expect(
        manager.run({ noRollbackFor: [BusinessErrorA] }, async () => {
          manager.registerAfterCommit(async () => {
            afterCommitRan = true;
          });
          manager.registerAfterRollback(async (err) => {
            afterRollbackReceived = err;
          });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(adapter.committedTransactions).toHaveLength(0);
      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(afterCommitRan).toBe(false);
      expect(afterRollbackReceived).toBe(boom);
    });

    it('noRollbackFor wins over rollbackFor when both match (Spring precedence)', async () => {
      let afterCommitRan = false;
      let afterRollbackRan = false;
      const boom = new BusinessErrorA('a');

      await expect(
        manager.run(
          { rollbackFor: [BusinessErrorA], noRollbackFor: [BusinessErrorA] },
          async () => {
            manager.registerAfterCommit(async () => {
              afterCommitRan = true;
            });
            manager.registerAfterRollback(async () => {
              afterRollbackRan = true;
            });
            throw boom;
          },
        ),
      ).rejects.toBe(boom);

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
      expect(afterCommitRan).toBe(true);
      expect(afterRollbackRan).toBe(false);
    });
  });
});
