import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import { OutboxRelay } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { WorkflowClient } from '@nestjs/workflows';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AnalyticsProjection } from '../src/analytics/analytics.projection.js';
import { AppModule } from '../src/app.module.js';
import { PaymentsService } from '../src/fakes/payments.service.js';
import { fulfilmentId } from '../src/fulfilment/fulfil-order.workflow.js';
import { OrdersService } from '../src/orders/orders.service.js';
import { PlaceOrderCommand } from '../src/orders/place-order.handler.js';

describe('workflows-order-fulfilment (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let app: TestingModule;
  let dataSource: DataSource;
  let commands: CommandBus;
  let orders: OrdersService;
  let workflows: WorkflowClient;
  let analytics: AnalyticsProjection;
  let relay: OutboxRelay;

  const outboxTopics = async (): Promise<string[]> => {
    const rows: { topic: string }[] = await dataSource.query(
      'SELECT topic FROM nest_outbox.messages ORDER BY seq',
    );
    return rows.map((row) => row.topic);
  };
  const status = async (orderId: string): Promise<string | undefined> =>
    ((await workflows.getStatus(fulfilmentId(orderId))) as { status?: string } | null)?.status;

  /** Polls the workflow until it reaches `expected`; the worker runs it in the background. */
  async function waitForStatus(orderId: string, expected: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await status(orderId)) === expected) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(
      `fulfilment of ${orderId} never became ${expected}, is ${await status(orderId)}`,
    );
  }

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TransactionalTypeOrmModule.resetForTesting();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    app = await Test.createTestingModule({
      imports: [
        AppModule.forPostgres(
          {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          { relay: false },
        ),
      ],
    }).compile();
    await app.init();

    dataSource = app.get<DataSource>(getDataSourceToken());
    commands = app.get(CommandBus);
    orders = app.get(OrdersService);
    workflows = app.get(WorkflowClient);
    analytics = app.get(AnalyticsProjection);
    relay = app.get(OutboxRelay);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
    jest.restoreAllMocks();
  });

  it('one command commits the order, starts the workflow and adds the outbox message', async () => {
    await commands.execute(new PlaceOrderCommand('o-1', 'book', 1, 2_500));

    expect((await orders.find('o-1'))?.id).toBe('o-1');
    expect(await workflows.getStatus(fulfilmentId('o-1'))).not.toBeNull();
    expect(await outboxTopics()).toContain('orders.placed');

    await relay.runOnce();
    expect(analytics.seen).toContain('placed o-1');
  });

  it('the workflow charges, reserves and marks the order paid, then waits for the delivery', async () => {
    await waitForStatus('o-1', 'suspended');

    const order = await orders.find('o-1');
    expect(order?.status).toBe('paid');
    expect(order?.chargeId).toMatch(/^ch_/);

    // `mark-paid` added `orders.paid` in its own transaction.
    await relay.runOnce();
    expect(analytics.seen).toContain('paid o-1');
  });

  it('a command that fails leaves no order, no workflow and no outbox message', async () => {
    const before = await outboxTopics();

    await expect(
      commands.execute(new PlaceOrderCommand('o-2', 'book', 1, 2_500, true)),
    ).rejects.toThrow('everything rolls back');

    expect(await orders.find('o-2')).toBeNull();
    expect(await workflows.getStatus(fulfilmentId('o-2'))).toBeNull();
    expect(await outboxTopics()).toEqual(before);
  });

  it('a delivery webhook that fails does not wake the workflow', async () => {
    await expect(orders.confirmDelivery('o-1', 'ups', true)).rejects.toThrow('signal rolls back');

    expect((await orders.find('o-1'))?.status).toBe('paid');
    // Well past several worker polls, the instance is still parked.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await status('o-1')).toBe('suspended');
  });

  it('the delivery webhook commits the status and wakes the workflow, which completes', async () => {
    await orders.confirmDelivery('o-1', 'ups');

    const result = await workflows.result(fulfilmentId('o-1'), { timeout: '20s' });
    expect(result).toMatchObject({ carrier: 'ups', chargeId: expect.stringMatching(/^ch_/) });
    expect((await orders.find('o-1'))?.status).toBe('delivered');
  });

  it('a step that fails for good runs the compensations: refund, cancel', async () => {
    await commands.execute(new PlaceOrderCommand('o-3', 'out-of-stock', 1, 4_000));

    await waitForStatus('o-3', 'failed');

    expect((await orders.find('o-3'))?.status).toBe('cancelled');
    const charges = [...app.get(PaymentsService).charges.values()].filter(
      (c) => c.orderId === 'o-3',
    );
    expect(charges).toEqual([{ orderId: 'o-3', amountCents: 4_000, refunded: true }]);
  });
});
