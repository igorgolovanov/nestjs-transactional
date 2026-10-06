import type { WorkflowClient } from '@nestjs/workflows';
import {
  AdapterRegistry,
  TransactionContext,
  TransactionManager,
} from '@nestjs-transactional/core';
import {
  InMemoryTransactionAdapter,
  type InMemoryTransactionHandle,
} from '@nestjs-transactional/core/testing';

import { WorkflowIsolationError } from '../errors.js';

import { WorkflowClientBinding } from './workflow-client-binding.js';

class PostgresAdapter extends InMemoryTransactionAdapter {
  readonly dialect = 'postgres';
  nativeTransaction(handle: InMemoryTransactionHandle): unknown {
    return { native: handle.id };
  }
}

interface Call {
  readonly method: string;
  readonly options: { transaction?: unknown } | undefined;
}

/** Records how start() and signal() were called; startAndWait() calls start() as the real one does. */
function fakeClient(): { client: WorkflowClient; calls: Call[]; release: () => void } {
  const calls: Call[] = [];
  let release = (): void => undefined;
  const client = {
    start(_workflow: unknown, _input: unknown, options?: { transaction?: unknown }) {
      calls.push({ method: 'start', options });
      return new Promise((resolve) => {
        release = () => resolve({ id: 'wf-1' });
        setImmediate(release);
      });
    },
    signal(_signal: unknown, _payload: unknown, options?: { transaction?: unknown }) {
      calls.push({ method: 'signal', options });
      return Promise.resolve({ delivered: 1 });
    },
    async startAndWait(workflow: unknown, input: unknown, options?: { transaction?: unknown }) {
      const { id } = (await (this as unknown as WorkflowClient).start(
        workflow as string,
        input,
        options,
      )) as { id: string };
      return id;
    },
  };
  return { client: client as unknown as WorkflowClient, calls, release };
}

function setup(adapter: InMemoryTransactionAdapter = new PostgresAdapter()): TransactionManager {
  const registry = new AdapterRegistry();
  registry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
  registry.register({
    adapterName: 'in-memory',
    instanceName: 'billing',
    adapter: new PostgresAdapter('billing'),
  });
  return new TransactionManager(registry);
}

const handleId = (): string | undefined =>
  TransactionContext.getActiveTransactionByDataSource('default')?.handle.id;

describe('WorkflowClientBinding', () => {
  it("passes the ambient transaction's native transaction to start() and signal()", async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, {});

    const id = await manager.run({}, async () => {
      await client.start('order', {});
      await client.signal('delivered', {});
      return handleId();
    });

    expect(calls.map((c) => [c.method, c.options?.transaction])).toEqual([
      ['start', { native: id }],
      ['signal', { native: id }],
    ]);
  });

  it('keeps the other options it was given', async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, {});

    await manager.run({}, () => client.start('order', {}, { id: 'order-1', priority: 5 }));

    expect(calls[0]?.options).toMatchObject({ id: 'order-1', priority: 5 });
  });

  it('leaves a transaction the caller passed alone', async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, {});

    await manager.run({}, () => client.start('order', {}, { transaction: 'mine' }));

    expect(calls[0]?.options?.transaction).toBe('mine');
  });

  it('adds nothing outside a transaction', async () => {
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, setup(), {});

    await client.start('order', {});

    expect(calls[0]?.options).toBeUndefined();
  });

  it('joins only the configured DataSource', async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, { dataSource: 'billing' });

    await manager.run({}, () => client.start('order', {}));
    await manager.run({ dataSource: 'billing' }, () => client.start('invoice', {}));

    expect(calls[0]?.options).toBeUndefined();
    expect(calls[1]?.options?.transaction).toBeDefined();
  });

  it('uses a transactionResolver when given one', async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, { transactionResolver: () => 'resolved' });

    await manager.run({}, () => client.start('order', {}));

    expect(calls[0]?.options?.transaction).toBe('resolved');
  });

  it('holds COMMIT until a start nobody awaited has written', async () => {
    const adapter = new PostgresAdapter();
    const manager = setup(adapter);
    const { client } = fakeClient();
    new WorkflowClientBinding(client, manager, {});
    let committedWhileWriting: number | undefined;

    await manager.run({}, async () => {
      void client.start('order', {}).then(() => {
        committedWhileWriting = adapter.committedTransactions.length;
      });
    });

    expect(committedWhileWriting).toBe(0);
    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('lets startAndWait() create the instance on its own, so its wait can see it', async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, {});

    await manager.run({}, () => client.startAndWait('order', {}));

    expect(calls[0]?.options?.transaction).toBeUndefined();
  });

  it.each(['SERIALIZABLE', 'REPEATABLE_READ'] as const)(
    'refuses a signal under %s on PostgreSQL before writing anything',
    async (isolation) => {
      const manager = setup();
      const { client, calls } = fakeClient();
      new WorkflowClientBinding(client, manager, {});

      const attempt = manager.run({ isolation }, () => client.signal('delivered', {}));

      await expect(attempt).rejects.toThrow(WorkflowIsolationError);
      await expect(
        manager.run({ isolation }, () => client.signal('delivered', {})),
      ).rejects.toThrow(new RegExp(`'default'.*${isolation}`));
      expect(calls).toEqual([]);
    },
  );

  it('lets a start through under SERIALIZABLE, which the store accepts', async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, {});

    await manager.run({ isolation: 'SERIALIZABLE' }, () => client.start('order', {}));

    expect(calls[0]?.options?.transaction).toBeDefined();
  });

  it("leaves a signal to the store's own check when the adapter reports no dialect", async () => {
    class NoDialectAdapter extends InMemoryTransactionAdapter {
      nativeTransaction(handle: InMemoryTransactionHandle): unknown {
        return handle.id;
      }
    }
    const manager = setup(new NoDialectAdapter());
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, {});

    await manager.run({ isolation: 'SERIALIZABLE' }, () => client.signal('delivered', {}));

    expect(calls[0]?.options?.transaction).toBeDefined();
  });

  it('wraps a client once, however many bindings are built', async () => {
    const manager = setup();
    const { client, calls } = fakeClient();
    new WorkflowClientBinding(client, manager, {});
    new WorkflowClientBinding(client, manager, { transactionResolver: () => 'second' });

    await manager.run({}, () => client.start('order', {}));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options?.transaction).not.toBe('second');
  });
});
