import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { NewOutboxMessage, Outbox } from '@nestjs/outbox';
import {
  AdapterRegistry,
  IllegalTransactionStateError,
  TransactionManager,
} from '@nestjs-transactional/core';
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';

import { Externalized } from '../externalization/externalized.decorator.js';

import { OutboxEventPublisher } from './outbox-event-publisher.js';

@Externalized<OrderPlaced>({
  target: 'orders.placed',
  client: 'KAFKA',
  routingKey: (e) => e.orderId,
  headers: (e) => ({ tenant: e.tenant }),
})
class OrderPlaced {
  constructor(
    readonly orderId: string,
    readonly tenant = 't-1',
  ) {}
}

class StockReserved {
  constructor(readonly sku: string) {}
}

interface AddCall {
  readonly tx: unknown;
  readonly message: NewOutboxMessage;
}

function fakeOutbox(): { outbox: Outbox; calls: AddCall[]; notify: jest.Mock } {
  const calls: AddCall[] = [];
  const notify = jest.fn();
  const outbox = {
    add: async (tx: unknown, message: NewOutboxMessage | readonly NewOutboxMessage[]) => {
      for (const m of Array.isArray(message) ? message : [message]) {
        calls.push({ tx, message: m as NewOutboxMessage });
      }
      return message;
    },
    notify,
  } as unknown as Outbox;
  return { outbox, calls, notify };
}

describe('OutboxEventPublisher', () => {
  let manager: TransactionManager;
  let calls: AddCall[];
  let notify: jest.Mock;
  let publisher: OutboxEventPublisher;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const registry = new AdapterRegistry();
    registry.register({
      adapterName: 'in-memory',
      instanceName: 'default',
      adapter: new InMemoryTransactionAdapter('default'),
    });
    registry.register({
      adapterName: 'in-memory',
      instanceName: 'billing',
      adapter: new InMemoryTransactionAdapter('billing'),
    });
    manager = new TransactionManager(registry);

    const fake = fakeOutbox();
    calls = fake.calls;
    notify = fake.notify;
    publisher = new OutboxEventPublisher(fake.outbox, {
      dataSource: 'default',
      // The in-memory handle has no `entityManager`; hand the handle itself
      // to `add()` so the spec can check which transaction was used.
      transactionResolver: (active) => active.handle,
    });
  });

  describe('publish()', () => {
    it('adds an @Externalized event under its target, key and headers', async () => {
      let handle: unknown;
      await manager.run({}, async () => {
        await publisher.publish(new OrderPlaced('o-1'));
        handle = calls[0]?.tx;
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.message).toEqual({
        topic: 'orders.placed',
        payload: new OrderPlaced('o-1'),
        key: 'o-1',
        headers: { tenant: 't-1', 'x-event-type': 'OrderPlaced' },
      });
      expect(handle).toBeDefined();
    });

    it('adds an event without @Externalized under its class name, for a local handler', async () => {
      await manager.run({}, async () => {
        await publisher.publish(new StockReserved('sku-1'));
      });

      expect(calls[0]!.message).toEqual({
        topic: 'StockReserved',
        payload: new StockReserved('sku-1'),
        headers: { 'x-event-type': 'StockReserved' },
      });
    });

    it('wakes the relay after the commit, once per transaction', async () => {
      await manager.run({}, async () => {
        await publisher.publish(new OrderPlaced('o-1'));
        await publisher.publish(new OrderPlaced('o-2'));
        expect(notify).not.toHaveBeenCalled();
      });

      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('does not wake the relay when the transaction rolls back', async () => {
      await expect(
        manager.run({}, async () => {
          await publisher.publish(new OrderPlaced('o-1'));
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      expect(notify).not.toHaveBeenCalled();
    });

    it('throws outside a transaction', async () => {
      await expect(publisher.publish(new OrderPlaced('o-1'))).rejects.toThrow(
        IllegalTransactionStateError,
      );
      expect(calls).toHaveLength(0);
    });

    it('throws, naming both, when only another dataSource has a transaction', async () => {
      await expect(
        manager.run({ dataSource: 'billing' }, () => publisher.publish(new OrderPlaced('o-1'))),
      ).rejects.toThrow(/'default'.*'billing'|'billing'.*'default'/s);
      expect(calls).toHaveLength(0);
    });
  });

  describe('publishAll()', () => {
    it('adds every event in order', async () => {
      await manager.run({}, () =>
        publisher.publishAll([new OrderPlaced('o-1'), new StockReserved('s-1')]),
      );

      expect(calls.map((c) => c.message.topic)).toEqual(['orders.placed', 'StockReserved']);
    });
  });

  describe('scheduleForPublication()', () => {
    it('buffers @Externalized events and writes them before the commit', async () => {
      await manager.run({}, async () => {
        publisher.scheduleForPublication(new OrderPlaced('o-1'));
        publisher.scheduleForPublication(new OrderPlaced('o-2'));
        expect(calls).toHaveLength(0);
      });

      expect(calls.map((c) => c.message.key)).toEqual(['o-1', 'o-2']);
      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('writes nothing when the transaction rolls back', async () => {
      await expect(
        manager.run({}, async () => {
          publisher.scheduleForPublication(new OrderPlaced('o-1'));
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      expect(calls).toHaveLength(0);
    });

    it('ignores events without @Externalized, which stay with the in-memory dispatcher', async () => {
      await manager.run({}, async () => {
        publisher.scheduleForPublication(new StockReserved('s-1'));
      });

      expect(calls).toHaveLength(0);
    });

    it('logs and drops an @Externalized event scheduled outside a transaction', () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      publisher.scheduleForPublication(new OrderPlaced('o-1'));

      expect(calls).toHaveLength(0);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toMatch(/OrderPlaced/);
    });
  });

  describe('default transactionResolver', () => {
    it('refuses a handle without an entityManager, naming the adapter', async () => {
      const fake = fakeOutbox();
      const typeOrmDefault = new OutboxEventPublisher(fake.outbox, { dataSource: 'default' });

      await expect(
        manager.run({}, () => typeOrmDefault.publish(new OrderPlaced('o-1'))),
      ).rejects.toThrow(/in-memory.*transactionResolver/s);
    });
  });
});
