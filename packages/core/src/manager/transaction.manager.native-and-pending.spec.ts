import { TransactionContext, type ActiveTransaction } from '../context/transaction.context.js';
import {
  InMemoryTransactionAdapter,
  type InMemoryTransactionHandle,
} from '../testing/in-memory.adapter.js';
import { IllegalTransactionStateError } from '../types/errors.js';

import { AdapterRegistry } from './adapter.registry.js';
import { TransactionManager } from './transaction.manager.js';

class NativeAdapter extends InMemoryTransactionAdapter {
  nativeTransaction(handle: InMemoryTransactionHandle): unknown {
    return { native: handle.id };
  }
}

function setup(adapter: InMemoryTransactionAdapter): TransactionManager {
  const registry = new AdapterRegistry();
  registry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
  return new TransactionManager(registry);
}

function active(): ActiveTransaction {
  const tx = TransactionContext.getActiveTransactionByDataSource('default');
  if (tx === undefined) {
    throw new Error('expected an active transaction');
  }
  return tx;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('TransactionManager.nativeTransactionOf', () => {
  it("returns what the adapter's nativeTransaction gives for the handle", async () => {
    const manager = setup(new NativeAdapter());

    const native = await manager.run({}, async () => {
      const tx = active();
      return { native: manager.nativeTransactionOf(tx), id: tx.handle.id };
    });

    expect(native.native).toEqual({ native: native.id });
  });

  it('throws IllegalTransactionStateError naming the adapter when it has no nativeTransaction', async () => {
    const manager = setup(new InMemoryTransactionAdapter());

    const attempt = manager.run({}, async () => manager.nativeTransactionOf(active()));

    await expect(attempt).rejects.toThrow(IllegalTransactionStateError);
    await expect(
      manager.run({}, async () => manager.nativeTransactionOf(active())),
    ).rejects.toThrow(/in-memory/);
  });
});

describe('TransactionManager.trackPending', () => {
  it('waits for a pending write before COMMIT', async () => {
    const adapter = new InMemoryTransactionAdapter();
    const manager = setup(adapter);
    const order: string[] = [];

    await manager.run({}, async () => {
      manager.trackPending(
        active(),
        tick().then(() => {
          order.push('pending settled');
        }),
      );
    });
    order.push(`committed ${adapter.committedTransactions.length}`);

    expect(order).toEqual(['pending settled', 'committed 1']);
  });

  it('waits for a write tracked by a before-commit hook that is already draining', async () => {
    const adapter = new InMemoryTransactionAdapter();
    const manager = setup(adapter);
    let late = false;

    await manager.run({}, async () => {
      const tx = active();
      manager.trackPending(
        tx,
        tick().then(() => {
          manager.trackPending(
            tx,
            tick().then(() => {
              late = true;
            }),
          );
        }),
      );
    });

    expect(late).toBe(true);
    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('rolls back with the error of a rejected pending write', async () => {
    const adapter = new InMemoryTransactionAdapter();
    const manager = setup(adapter);
    const boom = new Error('workflow write failed');

    await expect(
      manager.run({}, async () => {
        manager.trackPending(
          active(),
          tick().then(() => Promise.reject(boom)),
        );
      }),
    ).rejects.toBe(boom);

    expect(adapter.committedTransactions).toHaveLength(0);
    expect(adapter.rolledBackTransactions[0]?.error).toBe(boom);
  });

  it('does not leave an unhandled rejection when the body fails first', async () => {
    const adapter = new InMemoryTransactionAdapter();
    const manager = setup(adapter);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      await expect(
        manager.run({}, async () => {
          manager.trackPending(active(), Promise.reject(new Error('pending')));
          throw new Error('body');
        }),
      ).rejects.toThrow('body');
      await tick();
      await tick();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('registers a single drain hook per transaction', async () => {
    const manager = setup(new InMemoryTransactionAdapter());

    const hooks = await manager.run({}, async () => {
      const tx = active();
      manager.trackPending(tx, Promise.resolve());
      manager.trackPending(tx, Promise.resolve());
      manager.trackPending(tx, Promise.resolve());
      return tx.beforeCommitHooks.length;
    });

    expect(hooks).toBe(1);
  });
});
