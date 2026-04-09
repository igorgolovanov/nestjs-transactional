import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
} from '@nestjs-transactional/outbox-typeorm';
import {
  FailedEventPublications,
  OutboxModule,
  PublicationStatus,
} from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { REFUNDS_BROKER } from '../src/clients';
import { ProcessedRefundEntity } from '../src/processed-refunds.entity';
import { RefundConsumerService } from '../src/refund-consumer.service';
import { RefundEntity } from '../src/refund.entity';
import { RefundLedgerHandler } from '../src/refund-ledger.handler';
import { RefundRequestedEvent } from '../src/refund-requested.event';
import { RefundService } from '../src/refund.service';

interface ProxyMock {
  proxy: ClientProxy;
  emit: jest.Mock;
}

function makeProxy(): ProxyMock {
  const emit = jest.fn().mockReturnValue(of(undefined));
  const proxy = { emit } as unknown as ClientProxy;
  return { proxy, emit };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('externalization-with-fallback (Postgres real, ClientProxy mocked)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let refunds: RefundService;
  let ledger: RefundLedgerHandler;
  let consumer: RefundConsumerService;
  let failed: FailedEventPublications;
  let broker: ProxyMock;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    broker = makeProxy();

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
        ),
      ],
    })
      .overrideProvider(REFUNDS_BROKER)
      .useValue(broker.proxy)
      .compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    refunds = module.get(RefundService);
    ledger = module.get(RefundLedgerHandler);
    consumer = module.get(RefundConsumerService);
    failed = module.get(FailedEventPublications);
  }, 60_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await dataSource.getRepository(EventPublicationEntity).clear();
    await dataSource.getRepository(RefundEntity).clear();
    await dataSource.getRepository(ProcessedRefundEntity).clear();
    ledger.handled.length = 0;
    consumer.processed.length = 0;
    broker.emit.mockReset();
    broker.emit.mockReturnValue(of(undefined));
  });

  describe('ADR-016 silent-success contract', () => {
    it('emit() resolves successfully → publication COMPLETED, regardless of "real" broker state', async () => {
      // The mocked emit returns `of(undefined)` unconditionally — same
      // shape as a real ClientProxy succeeded against an unreachable
      // broker. The framework cannot distinguish the two.
      await refunds.requestRefund('rf-1', 'order-1', 5_000);

      await waitFor(() => ledger.handled.some((e) => e.refundId === 'rf-1'));
      await waitFor(() => broker.emit.mock.calls.length >= 1);

      // The publication COMPLETES — not because the broker confirmed
      // delivery, but because emit() returned without throwing.
      await waitFor(async () => {
        const row = await dataSource
          .getRepository(EventPublicationEntity)
          .findOne({ where: { eventType: 'RefundRequestedEvent' } });
        return row?.status === PublicationStatus.COMPLETED;
      });

      const row = await dataSource
        .getRepository(EventPublicationEntity)
        .findOne({ where: { eventType: 'RefundRequestedEvent' } });
      expect(row?.status).toBe(PublicationStatus.COMPLETED);
      expect(row?.failureReason).toBeNull();

      // The point: we cannot assert "broker received the message" from
      // the producer side. Mitigation lives on the consumer side
      // (next describe block).
    });
  });

  describe('FailedEventPublications.resubmit recovery', () => {
    it('emit() throws → publication FAILED → operator resubmits → next poll COMPLETES', async () => {
      // First emit attempt throws — surfaces the failure to the
      // externalizer (distinct from ADR-016 silent success).
      broker.emit.mockImplementationOnce(() => {
        throw new Error('simulated broker rejection');
      });

      await refunds.requestRefund('rf-fail', 'order-fail', 9_999);

      // Local ledger handler ran first (DD-019 ordering) — it always
      // sees the event regardless of broker outcome.
      await waitFor(() => ledger.handled.some((e) => e.refundId === 'rf-fail'));

      // Externalizer error → publication FAILED with failureReason.
      await waitFor(async () => {
        const row = await dataSource
          .getRepository(EventPublicationEntity)
          .findOne({ where: { eventType: 'RefundRequestedEvent' } });
        return row?.status === PublicationStatus.FAILED;
      });

      const failedRow = await dataSource
        .getRepository(EventPublicationEntity)
        .findOne({ where: { eventType: 'RefundRequestedEvent' } });
      expect(failedRow?.failureReason).toMatch(/simulated broker rejection/);

      // Operator API: count + resubmit.
      const beforeCount = await failed.count();
      expect(beforeCount).toBe(1);

      const resubmittedCount = await failed.resubmit();
      expect(resubmittedCount).toBe(1);

      // The processor picks up the RESUBMITTED row on the next poll.
      // Subsequent emit attempts use the default mock (succeeds).
      await waitFor(async () => {
        const row = await dataSource
          .getRepository(EventPublicationEntity)
          .findOne({ where: { eventType: 'RefundRequestedEvent' } });
        return row?.status === PublicationStatus.COMPLETED;
      });

      // Two emit attempts happened: one threw, one succeeded.
      expect(broker.emit.mock.calls.length).toBeGreaterThanOrEqual(2);

      const afterCount = await failed.count();
      expect(afterCount).toBe(0);
    });

    it('multiple failed publications resubmit in one operator call', async () => {
      broker.emit.mockImplementation(() => {
        throw new Error('simulated broker rejection');
      });

      await refunds.requestRefund('rf-a', 'order-a', 1_000);
      await refunds.requestRefund('rf-b', 'order-b', 2_000);
      await refunds.requestRefund('rf-c', 'order-c', 3_000);

      await waitFor(async () => (await failed.count()) === 3);

      // Now flip the broker back to succeeding so the resubmits clear.
      broker.emit.mockReset();
      broker.emit.mockReturnValue(of(undefined));

      const resubmitted = await failed.resubmit();
      expect(resubmitted).toBe(3);

      await waitFor(async () => {
        const rows = await dataSource.getRepository(EventPublicationEntity).find();
        return rows.every((r) => r.status === PublicationStatus.COMPLETED);
      });

      const rows = await dataSource.getRepository(EventPublicationEntity).find();
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.status === PublicationStatus.COMPLETED)).toBe(true);
    });
  });

  describe('Consumer-side inbox dedup template (ADR-016 mitigation strategy 2)', () => {
    it('first invocation processes; second invocation with same publication id is a no-op', async () => {
      const event = new RefundRequestedEvent('rf-dedup', 'order-dedup', 1_500);
      const publicationId = 'pub-id-rf-dedup';

      const first = await consumer.process(event, publicationId);
      const second = await consumer.process(event, publicationId);

      expect(first).toBe('processed');
      expect(second).toBe('duplicate');

      // Only one entry in the consumer's processed log.
      expect(consumer.processed).toHaveLength(1);
      expect(consumer.processed[0]?.event.refundId).toBe('rf-dedup');

      // Inbox table holds exactly one row for this publication id.
      const inbox = await dataSource.getRepository(ProcessedRefundEntity).find();
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.publicationId).toBe(publicationId);
    });

    it('different publication ids of the same event class are processed independently', async () => {
      const event = new RefundRequestedEvent('rf-multi', 'order-multi', 4_000);

      await consumer.process(event, 'pub-1');
      await consumer.process(event, 'pub-2');
      await consumer.process(event, 'pub-1'); // duplicate of pub-1

      expect(consumer.processed).toHaveLength(2);
      const inbox = await dataSource.getRepository(ProcessedRefundEntity).find();
      const ids = inbox.map((r) => r.publicationId).sort();
      expect(ids).toEqual(['pub-1', 'pub-2']);
    });
  });
});
