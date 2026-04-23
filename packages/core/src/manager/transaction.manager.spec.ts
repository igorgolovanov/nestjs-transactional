import { TransactionContext } from '../context/transaction.context';
import type { TransactionObserver } from '../observability/transaction-observer';
import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter';
import { IllegalTransactionStateError } from '../types/errors';
import { PropagationMode } from '../types/propagation';

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

  describe('propagation REQUIRES_NEW', () => {
    it('behaves like REQUIRED when no outer transaction is active', async () => {
      await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
        // body runs in the new transaction
      });

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
    });

    it('starts a separate transaction inside an active outer — adapter sees two distinct commits', async () => {
      await manager.run({}, async () => {
        await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
          // inner body
        });
      });

      expect(adapter.committedTransactions).toHaveLength(2);
      const ids = adapter.committedTransactions.map((t) => t.id);
      expect(new Set(ids).size).toBe(2);
    });

    it('inner REQUIRES_NEW rollback does not roll back the outer transaction', async () => {
      const innerBoom = new Error('inner boom');

      await manager.run({}, async () => {
        await expect(
          manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
            throw innerBoom;
          }),
        ).rejects.toBe(innerBoom);
        // outer keeps running and commits normally
      });

      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions[0]?.error).toBe(innerBoom);
      expect(adapter.committedTransactions).toHaveLength(1);
    });

    it('outer rollback leaves the inner REQUIRES_NEW commit intact', async () => {
      const outerBoom = new Error('outer boom');

      await expect(
        manager.run({}, async () => {
          await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
            // inner commits successfully
          });
          throw outerBoom;
        }),
      ).rejects.toBe(outerBoom);

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions[0]?.error).toBe(outerBoom);
    });

    it('inner AFTER_COMMIT hook fires on inner commit and is independent of outer lifecycle', async () => {
      let innerAfterCommitRan = false;
      let outerAfterCommitRan = false;
      let outerAfterRollbackReceived: unknown;
      const outerBoom = new Error('outer boom');

      await expect(
        manager.run({}, async () => {
          manager.registerAfterCommit(async () => {
            outerAfterCommitRan = true;
          });
          manager.registerAfterRollback(async (err) => {
            outerAfterRollbackReceived = err;
          });

          await manager.run({ propagation: PropagationMode.REQUIRES_NEW }, async () => {
            manager.registerAfterCommit(async () => {
              innerAfterCommitRan = true;
            });
          });

          // At this point the inner AFTER_COMMIT has already fired
          expect(innerAfterCommitRan).toBe(true);

          throw outerBoom;
        }),
      ).rejects.toBe(outerBoom);

      expect(innerAfterCommitRan).toBe(true);
      expect(outerAfterCommitRan).toBe(false);
      expect(outerAfterRollbackReceived).toBe(outerBoom);
    });
  });

  describe('propagation NESTED', () => {
    it('behaves like REQUIRED when no outer transaction is active', async () => {
      await manager.run({ propagation: PropagationMode.NESTED }, async () => {
        // body
      });

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.savepointsCreated).toHaveLength(0);
    });

    it('creates a savepoint inside an active outer transaction and releases it on success', async () => {
      await manager.run({}, async () => {
        await manager.run({ propagation: PropagationMode.NESTED }, async () => {
          // body
        });
      });

      expect(adapter.savepointsCreated).toHaveLength(1);
      expect(adapter.savepointsReleased).toHaveLength(1);
      expect(adapter.savepointsRolledBack).toHaveLength(0);
      expect(adapter.committedTransactions).toHaveLength(1); // outer only
    });

    it('savepoint rollback lets the outer transaction continue and commit', async () => {
      const innerBoom = new Error('inner boom');

      await manager.run({}, async () => {
        await expect(
          manager.run({ propagation: PropagationMode.NESTED }, async () => {
            throw innerBoom;
          }),
        ).rejects.toBe(innerBoom);
        // outer keeps running
      });

      expect(adapter.savepointsCreated).toHaveLength(1);
      expect(adapter.savepointsRolledBack).toHaveLength(1);
      expect(adapter.savepointsRolledBack[0]?.error).toBe(innerBoom);
      expect(adapter.savepointsReleased).toHaveLength(0);
      expect(adapter.committedTransactions).toHaveLength(1); // outer committed
      expect(adapter.rolledBackTransactions).toHaveLength(0);
    });

    it('AFTER_COMMIT hook registered inside NESTED attaches to the outer transaction', async () => {
      let hookRan = false;
      let releasedAtHookTime: number | undefined;
      let committedAtHookTime: number | undefined;

      await manager.run({}, async () => {
        await manager.run({ propagation: PropagationMode.NESTED }, async () => {
          manager.registerAfterCommit(async () => {
            hookRan = true;
            releasedAtHookTime = adapter.savepointsReleased.length;
            committedAtHookTime = adapter.committedTransactions.length;
          });
        });

        // Savepoint released, but hook NOT yet fired (outer still open)
        expect(adapter.savepointsReleased).toHaveLength(1);
        expect(hookRan).toBe(false);
      });

      expect(hookRan).toBe(true);
      expect(releasedAtHookTime).toBe(1);
      expect(committedAtHookTime).toBe(1); // outer already committed when hook runs
    });
  });

  describe('propagation SUPPORTS', () => {
    it('joins the active outer transaction — no new commit', async () => {
      let innerSawStore: boolean | undefined;

      await manager.run({}, async () => {
        await manager.run({ propagation: PropagationMode.SUPPORTS }, async () => {
          innerSawStore =
            TransactionContext.getActiveTransaction('in-memory:default') !== undefined;
        });
      });

      expect(innerSawStore).toBe(true);
      expect(adapter.committedTransactions).toHaveLength(1); // outer only
    });

    it('runs fn with no transaction when none is active, returning fn value', async () => {
      let ranWithoutTx: boolean | undefined;

      const result = await manager.run({ propagation: PropagationMode.SUPPORTS }, async () => {
        ranWithoutTx = TransactionContext.getActiveTransaction('in-memory:default') === undefined;
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(ranWithoutTx).toBe(true);
      expect(adapter.committedTransactions).toHaveLength(0);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
    });
  });

  describe('propagation NOT_SUPPORTED', () => {
    it('suspends the outer transaction for the duration of fn — inner sees no active tx', async () => {
      let innerSawActive: boolean | undefined;
      let outerRestoredAfterInner: boolean | undefined;

      await manager.run({}, async () => {
        await manager.run({ propagation: PropagationMode.NOT_SUPPORTED }, async () => {
          innerSawActive =
            TransactionContext.getActiveTransaction('in-memory:default') !== undefined;
        });
        outerRestoredAfterInner =
          TransactionContext.getActiveTransaction('in-memory:default') !== undefined;
      });

      expect(innerSawActive).toBe(false);
      expect(outerRestoredAfterInner).toBe(true);
      expect(adapter.committedTransactions).toHaveLength(1); // outer still commits
    });

    it('runs fn without a transaction when none is active', async () => {
      const result = await manager.run(
        { propagation: PropagationMode.NOT_SUPPORTED },
        async () => 'ok',
      );

      expect(result).toBe('ok');
      expect(adapter.committedTransactions).toHaveLength(0);
    });
  });

  describe('propagation NEVER', () => {
    it('throws IllegalTransactionStateError when called inside an active transaction', async () => {
      let neverBodyRan = false;

      await expect(
        manager.run({}, async () => {
          await manager.run({ propagation: PropagationMode.NEVER }, async () => {
            neverBodyRan = true;
          });
        }),
      ).rejects.toThrow(IllegalTransactionStateError);

      expect(neverBodyRan).toBe(false);
      // Outer rolls back because the NEVER throw propagates up through it
      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(adapter.committedTransactions).toHaveLength(0);
    });

    it('runs fn without a transaction when none is active', async () => {
      const result = await manager.run({ propagation: PropagationMode.NEVER }, async () => 'ok');

      expect(result).toBe('ok');
      expect(adapter.committedTransactions).toHaveLength(0);
    });
  });

  describe('propagation MANDATORY', () => {
    it('joins the active outer transaction — no new commit', async () => {
      let innerRan = false;

      await manager.run({}, async () => {
        await manager.run({ propagation: PropagationMode.MANDATORY }, async () => {
          innerRan = true;
        });
      });

      expect(innerRan).toBe(true);
      expect(adapter.committedTransactions).toHaveLength(1); // outer only
    });

    it('throws IllegalTransactionStateError when no outer transaction is active', async () => {
      let bodyRan = false;

      await expect(
        manager.run({ propagation: PropagationMode.MANDATORY }, async () => {
          bodyRan = true;
        }),
      ).rejects.toThrow(IllegalTransactionStateError);

      expect(bodyRan).toBe(false);
      expect(adapter.committedTransactions).toHaveLength(0);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
    });
  });

  describe('observability', () => {
    interface MockObserver {
      onTransactionStart: jest.Mock;
      onTransactionCommit: jest.Mock;
      onTransactionRollback: jest.Mock;
    }

    function makeObserver(): MockObserver {
      return {
        onTransactionStart: jest.fn(),
        onTransactionCommit: jest.fn(),
        onTransactionRollback: jest.fn(),
      };
    }

    it('fires onTransactionStart before the body runs, with the full context', async () => {
      const observer = makeObserver();
      manager = new TransactionManager(registry, [observer]);

      let observerCalledBeforeFn = false;
      observer.onTransactionStart.mockImplementation(() => {
        observerCalledBeforeFn = true;
      });

      await manager.run({ isolation: 'SERIALIZABLE' }, async () => {
        expect(observerCalledBeforeFn).toBe(true);
      });

      expect(observer.onTransactionStart).toHaveBeenCalledTimes(1);
      const ctx = observer.onTransactionStart.mock.calls[0]?.[0];
      expect(ctx.transactionId).toBeDefined();
      expect(ctx.transactionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ctx.adapterName).toBe('in-memory');
      expect(ctx.adapterInstanceName).toBe('default');
      expect(ctx.correlationId).toBeDefined();
      expect(ctx.options.isolation).toBe('SERIALIZABLE');
    });

    it('fires onTransactionCommit on success with durationMs and commitCount', async () => {
      const observer = makeObserver();
      manager = new TransactionManager(registry, [observer]);

      await manager.run({}, async () => {
        manager.registerAfterCommit(async () => {});
        manager.registerAfterCommit(async () => {});
      });

      expect(observer.onTransactionCommit).toHaveBeenCalledTimes(1);
      expect(observer.onTransactionRollback).not.toHaveBeenCalled();
      const ctx = observer.onTransactionCommit.mock.calls[0]?.[0];
      expect(ctx.commitCount).toBe(2);
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
      expect(ctx.transactionId).toBeDefined();
    });

    it('fires onTransactionRollback with error and rollbackCount', async () => {
      const observer = makeObserver();
      manager = new TransactionManager(registry, [observer]);
      const boom = new Error('boom');

      await expect(
        manager.run({}, async () => {
          manager.registerAfterRollback(async () => {});
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(observer.onTransactionRollback).toHaveBeenCalledTimes(1);
      expect(observer.onTransactionCommit).not.toHaveBeenCalled();
      const ctx = observer.onTransactionRollback.mock.calls[0]?.[0];
      expect(ctx.error).toBe(boom);
      expect(ctx.rollbackCount).toBe(1);
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('invokes every observer in the array', async () => {
      const first = makeObserver();
      const second = makeObserver();
      manager = new TransactionManager(registry, [first, second]);

      await manager.run({}, async () => {});

      expect(first.onTransactionStart).toHaveBeenCalledTimes(1);
      expect(first.onTransactionCommit).toHaveBeenCalledTimes(1);
      expect(second.onTransactionStart).toHaveBeenCalledTimes(1);
      expect(second.onTransactionCommit).toHaveBeenCalledTimes(1);
    });

    it('swallows errors from an observer and keeps invoking the rest', async () => {
      const failing: TransactionObserver = {
        onTransactionCommit: () => {
          throw new Error('observer boom');
        },
      };
      const succeeding = makeObserver();
      manager = new TransactionManager(registry, [failing, succeeding]);

      await expect(manager.run({}, async () => 'ok')).resolves.toBe('ok');

      expect(succeeding.onTransactionCommit).toHaveBeenCalledTimes(1);
      expect(adapter.committedTransactions).toHaveLength(1);
    });

    it('fires onTransactionCommit (not rollback) when noRollbackFor swallows the error', async () => {
      class BusinessError extends Error {}
      const observer = makeObserver();
      manager = new TransactionManager(registry, [observer]);

      await expect(
        manager.run({ noRollbackFor: [BusinessError] }, async () => {
          throw new BusinessError('biz');
        }),
      ).rejects.toThrow(BusinessError);

      expect(observer.onTransactionCommit).toHaveBeenCalledTimes(1);
      expect(observer.onTransactionRollback).not.toHaveBeenCalled();
    });
  });
});
