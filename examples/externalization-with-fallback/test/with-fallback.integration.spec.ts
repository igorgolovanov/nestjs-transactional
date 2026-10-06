import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
import { type OutboxEnvelope, OutboxDeadLetters, OutboxRelay } from '@nestjs/outbox';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module.js';
import { REFUNDS_BROKER } from '../src/clients.js';
import { RefundConsumerService } from '../src/refund-consumer.service.js';
import type { RefundRequestedEvent } from '../src/refund-requested.event.js';
import { RefundEntity } from '../src/refund.entity.js';
import { RefundService } from '../src/refund.service.js';

describe('externalization-with-fallback (Postgres real, ClientProxy recorded)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let refunds: RefundService;
  let consumer: RefundConsumerService;
  let relay: OutboxRelay;
  let deadLetters: OutboxDeadLetters;
  let emit: jest.Mock<(pattern: string, data: unknown) => unknown>;

  const pending = async (): Promise<{ attempts: number; last_error: string | null }[]> =>
    dataSource.query('SELECT attempts, last_error FROM nest_outbox.messages ORDER BY seq');

  /**
   * Makes every scheduled retry due now. The module backs off a second
   * and more between attempts, as a real deployment would; the test
   * moves the clock of the waiting messages instead of sleeping through
   * it.
   */
  const makeRetriesDue = async (): Promise<void> => {
    await dataSource.query('UPDATE nest_outbox.messages SET available_at = 0');
  };

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TransactionalTypeOrmModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    emit = jest.fn((_pattern: string, _data: unknown) => of(undefined));
    const proxy = { emit } as unknown as ClientProxy;

    module = await Test.createTestingModule({
      imports: [
        AppModule.forInfrastructure(
          {
            host: container.getHost(),
            port: container.getPort(),
            username: container.getUsername(),
            password: container.getPassword(),
            database: container.getDatabase(),
          },
          { url: 'amqp://unused' },
          { relay: false },
        ),
      ],
    })
      .overrideProvider(REFUNDS_BROKER)
      .useValue(proxy)
      .compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    refunds = module.get(RefundService);
    consumer = module.get(RefundConsumerService);
    relay = module.get(OutboxRelay);
    deadLetters = module.get(OutboxDeadLetters);
  }, 120_000);

  afterAll(async () => {
    await module?.close();
    await container?.stop();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE nest_outbox.messages, nest_outbox.dead_letters, nest_outbox.inbox',
    );
    await dataSource.getRepository(RefundEntity).clear();
    consumer.processed.length = 0;
    emit.mockClear();
    emit.mockImplementation(() => of(undefined));
  });

  describe('producer side', () => {
    it('a resolved emit delivers the envelope and the message leaves the outbox', async () => {
      await refunds.requestRefund('rf-1', 'order-1', 1_500);
      await relay.runOnce();

      expect(emit).toHaveBeenCalledTimes(1);
      const [pattern, envelope] = emit.mock.calls[0]! as [
        string,
        OutboxEnvelope<RefundRequestedEvent>,
      ];
      expect(pattern).toBe('refunds');
      expect(envelope.payload).toMatchObject({ refundId: 'rf-1', amountCents: 1_500 });
      expect(envelope.headers).toMatchObject({ 'x-correlation-id': 'rf-1' });
      expect(await pending()).toEqual([]);
    });

    it('a rejected emit keeps the message, with the reason, for a retry', async () => {
      emit.mockImplementation(() => {
        throw new Error('simulated broker outage');
      });

      await refunds.requestRefund('rf-2', 'order-2', 2_000);
      await relay.runOnce();

      const [message] = await pending();
      expect(message).toMatchObject({ attempts: 1 });
      expect(message!.last_error).toMatch(/simulated broker outage/);
    });

    it('a broker that recovers before the attempts run out gets the message on the retry', async () => {
      emit.mockImplementationOnce(() => {
        throw new Error('simulated broker blip');
      });

      await refunds.requestRefund('rf-3', 'order-3', 3_000);
      await relay.runOnce();
      expect(await pending()).toHaveLength(1);

      await makeRetriesDue();
      await relay.runOnce();

      expect(emit).toHaveBeenCalledTimes(2);
      expect(await pending()).toEqual([]);
    });

    it('exhausted attempts dead-letter the message; an operator requeue delivers it', async () => {
      emit.mockImplementation(() => {
        throw new Error('simulated long outage');
      });

      await refunds.requestRefund('rf-4', 'order-4', 4_000);
      // The module allows three attempts.
      for (let attempt = 0; attempt < 3; attempt++) {
        await makeRetriesDue();
        await relay.runOnce();
      }

      expect(await pending()).toEqual([]);
      const [dead] = await deadLetters.list();
      expect(dead).toMatchObject({ topic: 'refunds', reason: 'exhausted', attempts: 3 });
      expect(dead!.history).toHaveLength(3);
      expect(dead!.lastError).toMatch(/simulated long outage/);

      // The broker is back. The operator requeues, with a fresh budget.
      emit.mockImplementation(() => of(undefined));
      expect(await deadLetters.requeue(dead!.id)).toBe(1);
      await relay.runOnce();

      expect(await deadLetters.list()).toEqual([]);
      const delivered = emit.mock.calls.at(-1)![1] as OutboxEnvelope<RefundRequestedEvent>;
      // The same message, same id, so a consumer's inbox still recognises it.
      expect(delivered.id).toBe(dead!.id);
    });
  });

  describe('consumer side (inbox)', () => {
    const envelope = (id: string, refundId: string): OutboxEnvelope<RefundRequestedEvent> => ({
      id,
      topic: 'refunds',
      key: null,
      headers: {},
      createdAt: Date.now(),
      payload: { refundId, orderId: `order-${refundId}`, amountCents: 100 },
    });

    it('the first delivery is processed; a redelivery of the same id is a no-op', async () => {
      const message = envelope('m-1', 'rf-10');

      expect(await consumer.process(message)).toBe('processed');
      expect(await consumer.process(message)).toBe('duplicate');

      expect(consumer.processed).toEqual([{ refundId: 'rf-10', messageId: 'm-1' }]);
    });

    it('different message ids are processed independently', async () => {
      expect(await consumer.process(envelope('m-2', 'rf-11'))).toBe('processed');
      expect(await consumer.process(envelope('m-3', 'rf-12'))).toBe('processed');

      expect(consumer.processed.map((p) => p.messageId)).toEqual(['m-2', 'm-3']);
    });
  });
});
