import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { OutboxRelay } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { WorkflowClient } from '@nestjs/workflows';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalDrizzleModule } from '@nestjs-transactional/drizzle';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

import { AppModule } from '../src/app.module.js';
import { NotificationsHandler } from '../src/notifications/notifications.handler.js';
import { OrdersService } from '../src/orders/orders.service.js';
import { shippingId } from '../src/shipping/ship-order.workflow.js';

describe('drizzle-orders (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let app: TestingModule;
  let orders: OrdersService;
  let workflows: WorkflowClient;
  let relay: OutboxRelay;
  let notifications: NotificationsHandler;

  /** What is committed, read on a connection of its own. */
  async function committed<T>(text: string): Promise<T[]> {
    const client = new pg.Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    try {
      return (await client.query(text)).rows as T[];
    } finally {
      await client.end();
    }
  }
  const outboxTopics = async (): Promise<string[]> =>
    (await committed<{ topic: string }>('SELECT topic FROM nest_outbox.messages ORDER BY seq')).map(
      (row) => row.topic,
    );

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TransactionalDrizzleModule.resetForTesting();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    app = await Test.createTestingModule({
      imports: [
        AppModule.forPostgres(
          {
            host: container.getHost(),
            port: container.getPort(),
            user: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          { relay: false },
        ),
      ],
    }).compile();
    await app.init();

    orders = app.get(OrdersService);
    workflows = app.get(WorkflowClient);
    relay = app.get(OutboxRelay);
    notifications = app.get(NotificationsHandler);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    jest.restoreAllMocks();
  });

  it('commits the order, the outbox message and the workflow together', async () => {
    await orders.place('o-1', 'book', 2_500);

    // The worker polls every 50 ms and may already have shipped it.
    expect(await committed('SELECT id FROM orders')).toEqual([{ id: 'o-1' }]);
    expect(await outboxTopics()).toContain('orders.placed');
    expect(await workflows.getStatus(shippingId('o-1'))).not.toBeNull();
  });

  it('the workflow ships the order, its step writing in a transaction of its own', async () => {
    expect(await workflows.result(shippingId('o-1'), { timeout: '20s' })).toBe('trk-o-1');

    expect((await orders.find('o-1'))?.status).toBe('shipped');
    expect(await outboxTopics()).toEqual(['orders.placed', 'orders.shipped']);
  });

  it('a call that throws after writing leaves no order, no message and no workflow', async () => {
    await expect(orders.place('o-2', 'book', 2_500, true)).rejects.toThrow('everything rolls back');

    expect(await orders.find('o-2')).toBeUndefined();
    expect(await outboxTopics()).toEqual(['orders.placed', 'orders.shipped']);
    expect(await workflows.getStatus(shippingId('o-2'))).toBeNull();
  });

  it('the relay delivers what committed', async () => {
    await relay.runOnce();

    // One consumer per topic, so the two arrive in either order.
    expect([...notifications.sent].sort()).toEqual([
      'order o-1 received',
      'order o-1 shipped, tracking trk-o-1',
    ]);
  });
});
