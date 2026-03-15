import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  AdapterRegistry,
  TransactionManager,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { TransactionPhase } from '../types/transactional-listener.types';

import {
  type DispatcherListenerMetadata,
  TransactionalEventDispatcher,
} from './event-dispatcher';

// Inline fake adapter — standing in for `InMemoryTransactionAdapter` from
// `@nestjs-transactional/core/testing`. The subpath export can't be resolved
// under the monorepo's `moduleResolution: "node"` tsconfig setting.
interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

interface FakeCommit {
  readonly id: string;
  readonly options: TransactionOptions;
}

interface FakeRollback extends FakeCommit {
  readonly error: unknown;
}

class FakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';
  readonly dataSourceName = 'default';
  committedTransactions: FakeCommit[] = [];
  rolledBackTransactions: FakeRollback[] = [];

  async runInTransaction<T>(
    options: TransactionOptions,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    const handle: FakeHandle = { id: randomUUID(), adapterName: this.name };
    try {
      const result = await fn(handle);
      this.committedTransactions.push({ id: handle.id, options });
      return result;
    } catch (error) {
      this.rolledBackTransactions.push({ id: handle.id, options, error });
      throw error;
    }
  }

  async runInSavepoint<T>(parent: FakeHandle, fn: (handle: FakeHandle) => Promise<T>): Promise<T> {
    return fn(parent);
  }
}

class OrderPlaced {
  constructor(readonly orderId = 'order-1') {}
}

class PaymentCaptured {
  constructor(readonly paymentId = 'pay-1') {}
}

class ParentEvent {}
class ChildEvent extends ParentEvent {}

const metadata = (
  phase: TransactionPhase,
  overrides: Partial<DispatcherListenerMetadata> = {},
): DispatcherListenerMetadata => ({
  eventType: OrderPlaced,
  phase,
  fallbackExecution: false,
  async: false,
  ...overrides,
});

const flushMicrotasks = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

describe('TransactionalEventDispatcher', () => {
  let adapter: FakeAdapter;
  let registry: AdapterRegistry;
  let manager: TransactionManager;
  let dispatcher: TransactionalEventDispatcher;

  beforeEach(() => {
    adapter = new FakeAdapter();
    registry = new AdapterRegistry();
    registry.register({ adapterName: 'in-memory', instanceName: 'default', adapter });
    manager = new TransactionManager(registry);
    dispatcher = new TransactionalEventDispatcher(manager);
  });

  describe('inside an active transaction', () => {
    it('BEFORE_COMMIT listener runs before the adapter commits', async () => {
      let committedAtInvocation = -1;
      const host = {
        onPlaced: jest.fn(() => {
          committedAtInvocation = adapter.committedTransactions.length;
        }),
      };
      dispatcher.registerListener(host, 'onPlaced', metadata(TransactionPhase.BEFORE_COMMIT));

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlaced());
      });

      expect(host.onPlaced).toHaveBeenCalledTimes(1);
      expect(committedAtInvocation).toBe(0);
      expect(adapter.committedTransactions).toHaveLength(1);
    });

    it('AFTER_COMMIT listener runs after the adapter commits', async () => {
      let committedAtInvocation = -1;
      const host = {
        onPlaced: jest.fn(() => {
          committedAtInvocation = adapter.committedTransactions.length;
        }),
      };
      dispatcher.registerListener(host, 'onPlaced', metadata(TransactionPhase.AFTER_COMMIT));

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlaced());
      });

      expect(host.onPlaced).toHaveBeenCalledTimes(1);
      expect(committedAtInvocation).toBe(1);
    });

    it('AFTER_ROLLBACK listener runs on rollback and receives the causing error', async () => {
      let receivedError: unknown;
      const host = {
        onPlaced: jest.fn((_event: unknown, err: unknown) => {
          receivedError = err;
        }),
      };
      dispatcher.registerListener(host, 'onPlaced', metadata(TransactionPhase.AFTER_ROLLBACK));

      const boom = new Error('boom');
      await expect(
        manager.run({}, async () => {
          dispatcher.scheduleDispatch(new OrderPlaced());
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(host.onPlaced).toHaveBeenCalledTimes(1);
      expect(receivedError).toBe(boom);
      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(adapter.committedTransactions).toHaveLength(0);
    });

    it('AFTER_COMPLETION listener runs on both commit and rollback', async () => {
      const host = { onPlaced: jest.fn() };
      dispatcher.registerListener(host, 'onPlaced', metadata(TransactionPhase.AFTER_COMPLETION));

      // commit path
      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlaced());
      });
      expect(host.onPlaced).toHaveBeenCalledTimes(1);

      // rollback path
      const boom = new Error('rollback');
      await expect(
        manager.run({}, async () => {
          dispatcher.scheduleDispatch(new OrderPlaced());
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(host.onPlaced).toHaveBeenCalledTimes(2);
      const secondCallArgs = host.onPlaced.mock.calls[1];
      expect(secondCallArgs?.[1]).toBe(boom);
    });

    it('invokes multiple listeners for the same phase in registration order', async () => {
      const order: string[] = [];
      const l1 = {
        onPlaced: jest.fn(() => {
          order.push('l1');
        }),
      };
      const l2 = {
        onPlaced: jest.fn(() => {
          order.push('l2');
        }),
      };
      const l3 = {
        onPlaced: jest.fn(() => {
          order.push('l3');
        }),
      };
      dispatcher.registerListener(l1, 'onPlaced', metadata(TransactionPhase.AFTER_COMMIT));
      dispatcher.registerListener(l2, 'onPlaced', metadata(TransactionPhase.AFTER_COMMIT));
      dispatcher.registerListener(l3, 'onPlaced', metadata(TransactionPhase.AFTER_COMMIT));

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlaced());
      });

      expect(order).toEqual(['l1', 'l2', 'l3']);
    });
  });

  describe('listener failures', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    });

    it('an exception from a BEFORE_COMMIT listener rolls the transaction back', async () => {
      const failure = new Error('hook fail');
      const host = {
        onPlaced: jest.fn(() => {
          throw failure;
        }),
      };
      dispatcher.registerListener(host, 'onPlaced', metadata(TransactionPhase.BEFORE_COMMIT));

      await expect(
        manager.run({}, async () => {
          dispatcher.scheduleDispatch(new OrderPlaced());
        }),
      ).rejects.toBe(failure);

      expect(adapter.rolledBackTransactions).toHaveLength(1);
      expect(adapter.committedTransactions).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('an exception from an AFTER_COMMIT listener is logged, but the transaction stays committed', async () => {
      const host = {
        onPlaced: jest.fn(() => {
          throw new Error('after-commit fail');
        }),
      };
      dispatcher.registerListener(host, 'onPlaced', metadata(TransactionPhase.AFTER_COMMIT));

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlaced());
      });

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('outside any transaction', () => {
    it('skips listeners without fallbackExecution and logs a warning', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const host = { onPlaced: jest.fn() };
      dispatcher.registerListener(
        host,
        'onPlaced',
        metadata(TransactionPhase.AFTER_COMMIT, { fallbackExecution: false }),
      );

      dispatcher.scheduleDispatch(new OrderPlaced());
      await flushMicrotasks();

      expect(host.onPlaced).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/OrderPlaced/);
    });

    it('invokes fallbackExecution listeners via queueMicrotask (deferred, not sync)', async () => {
      const host = { onPlaced: jest.fn() };
      dispatcher.registerListener(
        host,
        'onPlaced',
        metadata(TransactionPhase.AFTER_COMMIT, { fallbackExecution: true }),
      );

      dispatcher.scheduleDispatch(new OrderPlaced());
      expect(host.onPlaced).not.toHaveBeenCalled();

      await flushMicrotasks();
      expect(host.onPlaced).toHaveBeenCalledTimes(1);
      expect(host.onPlaced.mock.calls[0]?.[0]).toBeInstanceOf(OrderPlaced);
    });
  });

  describe('async: true (fire-and-forget)', () => {
    it('does not block the commit path — manager.run resolves even if the listener never does', async () => {
      const host = {
        onPlaced: jest.fn(() => new Promise<void>(() => undefined)), // never resolves
      };
      dispatcher.registerListener(
        host,
        'onPlaced',
        metadata(TransactionPhase.AFTER_COMMIT, { async: true }),
      );

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlaced());
      });

      expect(host.onPlaced).toHaveBeenCalledTimes(1);
      expect(adapter.committedTransactions).toHaveLength(1);
    });
  });

  describe('event type matching', () => {
    it('matches on event.constructor.name — no subclass/superclass inference', async () => {
      const parentHost = { onEvent: jest.fn() };
      const childHost = { onEvent: jest.fn() };

      dispatcher.registerListener(parentHost, 'onEvent', {
        eventType: ParentEvent,
        phase: TransactionPhase.AFTER_COMMIT,
        fallbackExecution: false,
        async: false,
      });
      dispatcher.registerListener(childHost, 'onEvent', {
        eventType: ChildEvent,
        phase: TransactionPhase.AFTER_COMMIT,
        fallbackExecution: false,
        async: false,
      });

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new ParentEvent());
      });

      expect(parentHost.onEvent).toHaveBeenCalledTimes(1);
      expect(childHost.onEvent).not.toHaveBeenCalled();

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new ChildEvent());
      });

      expect(parentHost.onEvent).toHaveBeenCalledTimes(1); // still 1 — not re-invoked by child
      expect(childHost.onEvent).toHaveBeenCalledTimes(1);
    });

    it('does not invoke listeners registered for a different event type', async () => {
      const placedHost = { onPlaced: jest.fn() };
      const paymentHost = { onPayment: jest.fn() };

      dispatcher.registerListener(placedHost, 'onPlaced', metadata(TransactionPhase.AFTER_COMMIT));
      dispatcher.registerListener(paymentHost, 'onPayment', {
        eventType: PaymentCaptured,
        phase: TransactionPhase.AFTER_COMMIT,
        fallbackExecution: false,
        async: false,
      });

      await manager.run({}, async () => {
        dispatcher.scheduleDispatch(new OrderPlaced());
      });

      expect(placedHost.onPlaced).toHaveBeenCalledTimes(1);
      expect(paymentHost.onPayment).not.toHaveBeenCalled();
    });

    it('is a no-op when no listener is registered for the event', async () => {
      await expect(
        manager.run({}, async () => {
          dispatcher.scheduleDispatch(new OrderPlaced());
        }),
      ).resolves.toBeUndefined();

      expect(adapter.committedTransactions).toHaveLength(1);
    });
  });
});
