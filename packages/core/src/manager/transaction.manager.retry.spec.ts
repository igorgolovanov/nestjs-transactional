import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter.js';
import { PropagationMode } from '../types/propagation.js';

import { AdapterRegistry } from './adapter.registry.js';
import { TransactionManager } from './transaction.manager.js';

class SerializationFailure extends Error {
  readonly code = '40001';
}

class RetryingAdapter extends InMemoryTransactionAdapter {
  isRetryableError(error: unknown): boolean {
    return error instanceof SerializationFailure;
  }
}

function setup(adapter: InMemoryTransactionAdapter = new RetryingAdapter()): {
  manager: TransactionManager;
  adapter: InMemoryTransactionAdapter;
} {
  const registry = new AdapterRegistry();
  registry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
  return { manager: new TransactionManager(registry), adapter };
}

/** A body that fails with `error` on its first `failures` attempts. */
function failing(failures: number, error: () => Error = () => new SerializationFailure()) {
  let calls = 0;
  return {
    body: async (): Promise<string> => {
      calls += 1;
      if (calls <= failures) {
        throw error();
      }
      return `ok after ${calls}`;
    },
    calls: () => calls,
  };
}

describe('TransactionManager retry', () => {
  it('runs the transaction again after a retryable failure, in a fresh transaction', async () => {
    const { manager, adapter } = setup();
    const { body, calls } = failing(2);

    const result = await manager.run({ retry: { maxAttempts: 3, delay: 0 } }, body);

    expect(result).toBe('ok after 3');
    expect(calls()).toBe(3);
    expect(adapter.rolledBackTransactions).toHaveLength(2);
    expect(adapter.committedTransactions).toHaveLength(1);
    const ids = [...adapter.rolledBackTransactions, ...adapter.committedTransactions].map(
      (t) => t.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const { manager } = setup();
    const { body, calls } = failing(5);

    await expect(manager.run({ retry: 2 }, body)).rejects.toBeInstanceOf(SerializationFailure);
    expect(calls()).toBe(2);
  });

  it('does not retry an error the adapter does not call retryable', async () => {
    const { manager } = setup();
    const { body, calls } = failing(1, () => new Error('constraint violated'));

    await expect(manager.run({ retry: 3 }, body)).rejects.toThrow('constraint violated');
    expect(calls()).toBe(1);
  });

  it('retries nothing by default on an adapter without isRetryableError', async () => {
    const { manager } = setup(new InMemoryTransactionAdapter());
    const { body, calls } = failing(1);

    await expect(manager.run({ retry: 3 }, body)).rejects.toBeInstanceOf(SerializationFailure);
    expect(calls()).toBe(1);
  });

  it('uses retryIf in place of the adapter when given', async () => {
    const { manager } = setup(new InMemoryTransactionAdapter());
    const { body, calls } = failing(1, () => new Error('transient'));

    const result = await manager.run(
      { retry: { maxAttempts: 2, delay: 0, retryIf: (e) => (e as Error).message === 'transient' } },
      body,
    );

    expect(result).toBe('ok after 2');
    expect(calls()).toBe(2);
  });

  it('never retries an error that committed through noRollbackFor', async () => {
    const { manager, adapter } = setup();
    const { body, calls } = failing(1);

    await expect(
      manager.run({ retry: 3, noRollbackFor: [SerializationFailure] }, body),
    ).rejects.toBeInstanceOf(SerializationFailure);
    expect(calls()).toBe(1);
    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('waits the delay a function returns, with the attempt and the error', async () => {
    const { manager } = setup();
    const { body } = failing(2);
    const seen: [number, unknown][] = [];

    await manager.run(
      {
        retry: {
          maxAttempts: 3,
          delay: (attempt, error) => {
            seen.push([attempt, error]);
            return 1;
          },
        },
      },
      body,
    );

    expect(seen.map(([attempt]) => attempt)).toEqual([1, 2]);
    expect(seen[0]?.[1]).toBeInstanceOf(SerializationFailure);
  });

  it('runs fresh hooks on every attempt', async () => {
    const { manager } = setup();
    const { body } = failing(1);
    const events: string[] = [];

    await manager.run({ retry: { maxAttempts: 2, delay: 0 } }, async () => {
      manager.registerAfterCommit(async () => void events.push('commit'));
      manager.registerAfterRollback(async () => void events.push('rollback'));
      return body();
    });

    expect(events).toEqual(['rollback', 'commit']);
  });

  it('does not retry a call that joins an outer transaction; the outer one retries', async () => {
    const { manager } = setup();
    const { body, calls } = failing(1);

    const result = await manager.run({ retry: { maxAttempts: 2, delay: 0 } }, () =>
      manager.run({ retry: 5 }, body),
    );

    expect(result).toBe('ok after 2');
    expect(calls()).toBe(2);
  });

  it('retries a REQUIRES_NEW transaction on its own, inside an outer one', async () => {
    const { manager, adapter } = setup();
    const { body, calls } = failing(1);

    await manager.run({}, () =>
      manager.run(
        { propagation: PropagationMode.REQUIRES_NEW, retry: { maxAttempts: 2, delay: 0 } },
        body,
      ),
    );

    expect(calls()).toBe(2);
    expect(adapter.committedTransactions).toHaveLength(2);
  });

  it.each([0, 1.5, Number.NaN])('rejects maxAttempts %p', async (maxAttempts) => {
    const { manager } = setup();

    await expect(manager.run({ retry: { maxAttempts } }, async () => 'x')).rejects.toThrow(
      /maxAttempts must be an integer of at least 1/,
    );
  });

  it('defaults to a jittered backoff that stays within its cap', async () => {
    const { manager } = setup();
    const { body } = failing(1);
    const started = Date.now();

    await manager.run({ retry: 2 }, body);

    expect(Date.now() - started).toBeLessThan(1000);
  });
});
