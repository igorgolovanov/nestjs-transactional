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
import { OutboxModule, PublicationStatus } from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { of } from 'rxjs';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { BillingPaymentHandler } from '../src/billing.handler';
import { BillingService } from '../src/billing.service';
import { BILLING_BROKER, INVENTORY_BROKER } from '../src/clients';
import { InvoiceEntity, ReservationEntity } from '../src/entities';
import { InventoryAllocationHandler } from '../src/inventory.handler';
import { InventoryService } from '../src/inventory.service';

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

describe('externalization-multi-datasource (Postgres × 2 real, two ClientProxy mocked)', () => {
  let container: StartedPostgreSqlContainer;
  let billingDs: DataSource;
  let inventoryDs: DataSource;
  let module: TestingModule;
  let billing: BillingService;
  let inventory: InventoryService;
  let billingHandler: BillingPaymentHandler;
  let inventoryHandler: InventoryAllocationHandler;
  let billingBroker: ProxyMock;
  let inventoryBroker: ProxyMock;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // Create the inventory_db database via the container's psql admin
    // connection. testcontainers' default user has CREATEDB.
    const { Client } = await import('pg');
    const adminClient = new Client({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    });
    await adminClient.connect();
    await adminClient.query('CREATE DATABASE inventory_db');
    await adminClient.end();

    billingBroker = makeProxy();
    inventoryBroker = makeProxy();

    module = await Test.createTestingModule({
      imports: [
        AppModule.forConfig(
          {
            billing: {
              host: container.getHost(),
              port: container.getPort(),
              username: container.getUsername(),
              password: container.getPassword(),
              database: container.getDatabase(),
            },
            inventory: {
              host: container.getHost(),
              port: container.getPort(),
              username: container.getUsername(),
              password: container.getPassword(),
              database: 'inventory_db',
            },
          },
          { url: 'amqp://unused' },
        ),
      ],
    })
      .overrideProvider(BILLING_BROKER)
      .useValue(billingBroker.proxy)
      .overrideProvider(INVENTORY_BROKER)
      .useValue(inventoryBroker.proxy)
      .compile();

    // Worker noise — rolled-back rows briefly observed during tests.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    billingDs = module.get<DataSource>(getDataSourceToken());
    inventoryDs = module.get<DataSource>(getDataSourceToken('inventory'));
    billing = module.get(BillingService);
    inventory = module.get(InventoryService);
    billingHandler = module.get(BillingPaymentHandler);
    inventoryHandler = module.get(InventoryAllocationHandler);
  }, 60_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await billingDs.getRepository(EventPublicationArchiveEntity).clear();
    await billingDs.getRepository(EventPublicationEntity).clear();
    await billingDs.getRepository(InvoiceEntity).clear();
    await inventoryDs.getRepository(EventPublicationArchiveEntity).clear();
    await inventoryDs.getRepository(EventPublicationEntity).clear();
    await inventoryDs.getRepository(ReservationEntity).clear();
    billingHandler.handled.length = 0;
    inventoryHandler.handled.length = 0;
    billingBroker.emit.mockClear();
    inventoryBroker.emit.mockClear();
  });

  it('billing flow → BILLING_BROKER receives, inventory broker untouched', async () => {
    await billing.payInvoice('inv-1', 'alice@example.com', 5_000);

    await waitFor(() => billingHandler.handled.some((e) => e.invoiceId === 'inv-1'));
    await waitFor(() => billingBroker.emit.mock.calls.length >= 1);

    expect(billingBroker.emit).toHaveBeenCalledTimes(1);
    expect(billingBroker.emit).toHaveBeenCalledWith(
      'billing.events',
      expect.objectContaining({ invoiceId: 'inv-1' }),
    );
    expect(inventoryBroker.emit).not.toHaveBeenCalled();

    // Publication landed in the BILLING DB only (not the inventory DB).
    const billingPub = await billingDs.getRepository(EventPublicationEntity).find();
    const inventoryPub = await inventoryDs.getRepository(EventPublicationEntity).find();
    expect(billingPub).toHaveLength(1);
    expect(billingPub[0]?.eventType).toBe('InvoicePaidEvent');
    expect(billingPub[0]?.status).toBe(PublicationStatus.COMPLETED);
    expect(inventoryPub).toHaveLength(0);
  });

  it('inventory flow → INVENTORY_BROKER receives, billing broker untouched', async () => {
    await inventory.placeReservation('res-1', 'sku-A', 10);

    await waitFor(() =>
      inventoryHandler.handled.some((e) => e.reservationId === 'res-1'),
    );
    await waitFor(() => inventoryBroker.emit.mock.calls.length >= 1);

    expect(inventoryBroker.emit).toHaveBeenCalledTimes(1);
    expect(inventoryBroker.emit).toHaveBeenCalledWith(
      'inventory.events',
      expect.objectContaining({ reservationId: 'res-1', sku: 'sku-A' }),
    );
    expect(billingBroker.emit).not.toHaveBeenCalled();

    // Publication landed in the INVENTORY DB only.
    const billingPub = await billingDs.getRepository(EventPublicationEntity).find();
    const inventoryPub = await inventoryDs.getRepository(EventPublicationEntity).find();
    expect(billingPub).toHaveLength(0);
    expect(inventoryPub).toHaveLength(1);
    expect(inventoryPub[0]?.eventType).toBe('ReservationPlacedEvent');
    expect(inventoryPub[0]?.status).toBe(PublicationStatus.COMPLETED);
  });

  it('billing rollback: nothing on billing broker, inventory broker untouched (DD-023 cross-DS isolation)', async () => {
    // Establish prior inventory activity to prove rollback doesn't
    // affect it.
    await inventory.placeReservation('res-keep', 'sku-X', 1);
    await waitFor(() => inventoryBroker.emit.mock.calls.length >= 1);
    inventoryBroker.emit.mockClear();
    inventoryHandler.handled.length = 0;

    await expect(
      billing.payInvoice('inv-x', 'bob@example.com', 9_999, true),
    ).rejects.toThrow('billing rollback');

    // Billing side fully rolled back.
    expect(await billingDs.getRepository(InvoiceEntity).find()).toHaveLength(0);
    expect(await billingDs.getRepository(EventPublicationEntity).find()).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 300));
    expect(billingBroker.emit).not.toHaveBeenCalled();

    // Inventory side untouched — its prior reservation row still
    // exists and the inventory broker hasn't received anything new.
    expect(await inventoryDs.getRepository(ReservationEntity).find()).toHaveLength(1);
    expect(inventoryBroker.emit).not.toHaveBeenCalled();
  });

  it('inventory rollback: billing publication and emit untouched', async () => {
    await billing.payInvoice('inv-keep', 'carol@example.com', 1_500);
    await waitFor(() => billingBroker.emit.mock.calls.length >= 1);
    billingBroker.emit.mockClear();
    billingHandler.handled.length = 0;

    await expect(
      inventory.placeReservation('res-x', 'sku-Y', 99, true),
    ).rejects.toThrow('inventory rollback');

    expect(await inventoryDs.getRepository(ReservationEntity).find()).toHaveLength(0);
    expect(await inventoryDs.getRepository(EventPublicationEntity).find()).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 300));
    expect(inventoryBroker.emit).not.toHaveBeenCalled();
    expect(billingBroker.emit).not.toHaveBeenCalled();

    // Billing's earlier `inv-keep` row stays — DD-023 cross-DS
    // isolation extends to externalization.
    expect(await billingDs.getRepository(InvoiceEntity).find()).toHaveLength(1);
  });

  it('mixed flow: both DSes publish in turn, each broker receives only its events', async () => {
    await billing.payInvoice('inv-a', 'alice@example.com', 1_000);
    await inventory.placeReservation('res-a', 'sku-1', 5);
    await billing.payInvoice('inv-b', 'bob@example.com', 2_000);
    await inventory.placeReservation('res-b', 'sku-2', 7);

    await waitFor(
      () =>
        billingBroker.emit.mock.calls.length >= 2 &&
        inventoryBroker.emit.mock.calls.length >= 2,
    );

    const billingTargets = billingBroker.emit.mock.calls.map((c) => c[0]);
    const inventoryTargets = inventoryBroker.emit.mock.calls.map((c) => c[0]);

    expect(new Set(billingTargets)).toEqual(new Set(['billing.events']));
    expect(new Set(inventoryTargets)).toEqual(new Set(['inventory.events']));

    // Two completed publications per DS (DD-023 — independent
    // publication queues).
    const billingPub = await billingDs.getRepository(EventPublicationEntity).find();
    const inventoryPub = await inventoryDs.getRepository(EventPublicationEntity).find();
    expect(billingPub).toHaveLength(2);
    expect(inventoryPub).toHaveLength(2);
    expect(billingPub.every((r) => r.status === PublicationStatus.COMPLETED)).toBe(true);
    expect(inventoryPub.every((r) => r.status === PublicationStatus.COMPLETED)).toBe(true);
  });

  it('per-DS broker isolation: BILLING_BROKER throws → only billing publication FAILED, inventory side intact', async () => {
    billingBroker.emit.mockImplementation(() => {
      throw new Error('simulated billing broker rejection');
    });

    await billing.payInvoice('inv-fail', 'frank@example.com', 3_000);
    await inventory.placeReservation('res-ok', 'sku-Z', 4);

    // Local handlers run regardless.
    await waitFor(
      () =>
        billingHandler.handled.some((e) => e.invoiceId === 'inv-fail') &&
        inventoryHandler.handled.some((e) => e.reservationId === 'res-ok'),
    );

    // Inventory broker succeeds.
    await waitFor(() => inventoryBroker.emit.mock.calls.length >= 1);

    // Billing publication ends up FAILED; inventory publication
    // COMPLETED. Cross-broker isolation per DD-019 + DD-023.
    await waitFor(async () => {
      const billingRow = await billingDs
        .getRepository(EventPublicationEntity)
        .findOne({ where: { eventType: 'InvoicePaidEvent' } });
      const inventoryRow = await inventoryDs
        .getRepository(EventPublicationEntity)
        .findOne({ where: { eventType: 'ReservationPlacedEvent' } });
      return (
        billingRow?.status === PublicationStatus.FAILED &&
        inventoryRow?.status === PublicationStatus.COMPLETED
      );
    });

    const billingRow = await billingDs
      .getRepository(EventPublicationEntity)
      .findOne({ where: { eventType: 'InvoicePaidEvent' } });
    expect(billingRow?.failureReason).toMatch(/simulated billing broker rejection/);
  });
});
