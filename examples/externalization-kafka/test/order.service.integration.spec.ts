import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { type ClientProxy } from '@nestjs/microservices';
import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, PublicationStatus } from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';

import { AppModule, KAFKA_CLIENT } from '../src/app.module';
import { OrderEntity } from '../src/order.entity';
import { OrderService } from '../src/order.service';
import { ShippingHandler } from '../src/shipping.handler';

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

/**
 * Wait until this dataSource's publication rows satisfy `predicate`.
 *
 * The worker sets a row's terminal status *after* the handler — and, when
 * externalization is configured, after the broker emit — has returned.
 * So waiting on a handler flag or on an emit mock is not the same as
 * waiting on the row reaching COMPLETED: the gap is invisible on a fast
 * machine and real on a CI runner.
 */
async function waitForPublications(
  ds: DataSource,
  predicate: (rows: EventPublicationEntity[]) => boolean,
): Promise<void> {
  await waitFor(async () => predicate(await ds.getRepository(EventPublicationEntity).find()));
}

describe('externalization-kafka (Postgres real, ClientProxy mocked)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let dataSource: DataSource;
  let orders: OrderService;
  let shipping: ShippingHandler;
  let kafkaEmit: jest.Mock;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // Mock the Kafka ClientProxy. `emit` returns `of(undefined)`,
    // which is what a successful publish looks like to the
    // externalizer; it waits on `firstValueFrom(emit(...))`, so the
    // mocked Observable resolves immediately. Deliberately not a
    // broker test: the real Kafka acknowledgement path is measured
    // in the `outbox-microservices` suite (ADR-021).
    kafkaEmit = jest.fn().mockReturnValue(of(undefined));
    const kafkaProxyMock = { emit: kafkaEmit } as unknown as ClientProxy;

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
          { brokers: ['unused-mocked'], clientId: 'test' },
        ),
      ],
    })
      .overrideProvider(KAFKA_CLIENT)
      .useValue(kafkaProxyMock)
      .compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    await module.init();

    dataSource = module.get<DataSource>(getDataSourceToken());
    orders = module.get(OrderService);
    shipping = module.get(ShippingHandler);
  }, 60_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await dataSource.getRepository(EventPublicationArchiveEntity).clear();
    await dataSource.getRepository(EventPublicationEntity).clear();
    await dataSource.getRepository(OrderEntity).clear();
    shipping.handled.length = 0;
    kafkaEmit.mockClear();
  });

  it('commits orders + event_publication atomically; worker delivers to local handler AND Kafka', async () => {
    await orders.placeOrder('o-1', 'alice@example.com', 5_000);

    // Both rows present after commit.
    const orderRows = await dataSource.getRepository(OrderEntity).find();
    const publicationRows = await dataSource.getRepository(EventPublicationEntity).find();
    expect(orderRows.map((o) => o.id)).toEqual(['o-1']);
    expect(publicationRows).toHaveLength(1);
    expect(publicationRows[0]?.eventType).toBe('OrderPlacedEvent');

    // Local handler runs first (DD-019 ordering), then externalizer.
    await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-1'));
    await waitFor(() => kafkaEmit.mock.calls.length >= 1);

    // Externalizer calls `client.emit(target, event)`. The decorator's
    // `routingKey` and `headers` callbacks are resolved into
    // `ExternalizationMetadata` but `MicroservicesEventExternalizer`
    // currently passes only `(target, event)` — those fields are
    // available for transport-aware externalizers in future
    // iterations.
    expect(kafkaEmit).toHaveBeenCalledTimes(1);
    expect(kafkaEmit).toHaveBeenCalledWith(
      'orders.placed',
      expect.objectContaining({ orderId: 'o-1' }),
    );

    // Publication completes after BOTH local handler AND externalizer
    // succeed (single-unit atomicity per DD-019).
    await waitForPublications(
      dataSource,
      (rows) => rows[0]?.status === PublicationStatus.COMPLETED,
    );
    const completed = await dataSource.getRepository(EventPublicationEntity).findOne({
      where: { id: publicationRows[0]!.id },
    });
    expect(completed?.status).toBe(PublicationStatus.COMPLETED);
  });

  it('rolls back BOTH rows when the @Transactional method throws — Kafka NEVER emitted', async () => {
    await expect(
      orders.placeOrderAndFail('o-2', 'bob@example.com', 7_500),
    ).rejects.toThrow('simulated failure');

    // Single-unit atomicity (DD-019) — neither row exists.
    expect(await dataSource.getRepository(OrderEntity).find()).toHaveLength(0);
    expect(await dataSource.getRepository(EventPublicationEntity).find()).toHaveLength(0);

    // Externalization is downstream of the publication row — no row,
    // no externalization. The mocked Kafka emit never fires.
    await new Promise((r) => setTimeout(r, 300));
    expect(shipping.handled.find((e) => e.orderId === 'o-2')).toBeUndefined();
    expect(kafkaEmit).not.toHaveBeenCalled();
  });

  it('processes multiple orders independently — both Kafka emits happen, both publications COMPLETED', async () => {
    await orders.placeOrder('o-3', 'carol@example.com', 1_000);
    await orders.placeOrder('o-4', 'dave@example.com', 2_000);

    await waitFor(
      () =>
        shipping.handled.some((e) => e.orderId === 'o-3') &&
        shipping.handled.some((e) => e.orderId === 'o-4'),
    );
    await waitFor(() => kafkaEmit.mock.calls.length >= 2);

    expect(kafkaEmit.mock.calls.map((c) => (c[1] as { orderId: string }).orderId).sort()).toEqual([
      'o-3',
      'o-4',
    ]);

    await waitForPublications(
      dataSource,
      (rows) => rows.length === 2 && rows.every((r) => r.status === PublicationStatus.COMPLETED),
    );
    const completedRows = await dataSource.getRepository(EventPublicationEntity).find();
    expect(completedRows).toHaveLength(2);
    expect(completedRows.every((r) => r.status === PublicationStatus.COMPLETED)).toBe(true);
  });

  it('externalizer error marks the publication FAILED — local handler still ran (DD-019 ordering)', async () => {
    // Make every emit throw. Against a real Kafka this is what an
    // unreachable broker produces, since `producer.send()` rejects
    // and the default `acks: -1` waits for every in-sync replica.
    // The externalizer surfaces it and the publication transitions
    // to FAILED. Recovery via `FailedEventPublications.resubmit` is
    // shown in `externalization-with-fallback`.
    kafkaEmit.mockImplementation(() => {
      throw new Error('simulated broker rejection');
    });

    await orders.placeOrder('o-5', 'eve@example.com', 3_000);

    // Local handler runs FIRST (DD-019 ordering). Externalizer
    // running second means the local handler always executes —
    // even when the broker is unhappy.
    await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-5'));

    // Externalizer error → publication FAILED.
    await waitFor(async () => {
      const row = await dataSource
        .getRepository(EventPublicationEntity)
        .findOne({ where: { eventType: 'OrderPlacedEvent' } });
      return row?.status === PublicationStatus.FAILED;
    });

    const row = await dataSource
      .getRepository(EventPublicationEntity)
      .findOne({ where: { eventType: 'OrderPlacedEvent' } });
    expect(row?.status).toBe(PublicationStatus.FAILED);
    expect(row?.failureReason).toMatch(/simulated broker rejection/);
  });
});
