import 'reflect-metadata';

import { Logger } from '@nestjs/common';
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
import { Client } from 'pg';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { BillingPaymentProjectionListener } from '../src/billing/billing.listener';
import { BillingService } from '../src/billing/billing.service';
import { InvoiceRow } from '../src/billing/invoice.entity';
import { InventoryShipmentProjectionListener } from '../src/inventory/inventory.listener';
import { InventoryService } from '../src/inventory/inventory.service';
import { ReservationRow } from '../src/inventory/reservation.entity';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('shared-database-modular-monolith (Postgres schemas via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let billingDs: DataSource;
  let inventoryDs: DataSource;
  let module: TestingModule;
  let billing: BillingService;
  let inventory: InventoryService;
  let billingProjections: BillingPaymentProjectionListener;
  let inventoryProjections: InventoryShipmentProjectionListener;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // Pre-create the two schemas — TypeORM's `synchronize: true`
    // creates tables but the schema namespace itself must exist
    // first.
    const admin = new Client({
      host: container.getHost(),
      port: container.getPort(),
      user: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    });
    await admin.connect();
    await admin.query('CREATE SCHEMA billing');
    await admin.query('CREATE SCHEMA inventory');
    await admin.end();

    module = await Test.createTestingModule({
      imports: [
        AppModule.forPostgres({
          host: container.getHost(),
          port: container.getPort(),
          username: container.getUsername(),
          password: container.getPassword(),
          database: container.getDatabase(),
        }),
      ],
    }).compile();

    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    billingDs = module.get<DataSource>(getDataSourceToken());
    inventoryDs = module.get<DataSource>(getDataSourceToken('inventory'));
    billing = module.get(BillingService);
    inventory = module.get(InventoryService);
    billingProjections = module.get(BillingPaymentProjectionListener);
    inventoryProjections = module.get(InventoryShipmentProjectionListener);
  }, 90_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await billingDs.getRepository(EventPublicationArchiveEntity).clear();
    await billingDs.getRepository(EventPublicationEntity).clear();
    await billingDs.getRepository(InvoiceRow).clear();
    await inventoryDs.getRepository(EventPublicationArchiveEntity).clear();
    await inventoryDs.getRepository(EventPublicationEntity).clear();
    await inventoryDs.getRepository(ReservationRow).clear();
    billingProjections.observed.length = 0;
    inventoryProjections.observed.length = 0;
  });

  it('billing tx writes go to the billing schema only — physical schema isolation', async () => {
    await billing.payInvoice('inv-1', 'alice', 5_000);

    // Direct schema-qualified queries to verify physical placement.
    const invoicesInBilling = await billingDs.query(
      'SELECT id FROM billing.invoices ORDER BY id',
    );
    const invoicesInInventory = await inventoryDs.query(
      "SELECT to_regclass('inventory.invoices') AS exists",
    );
    expect(invoicesInBilling).toEqual([{ id: 'inv-1' }]);
    // No `invoices` table in the inventory schema at all.
    expect(invoicesInInventory[0].exists).toBeNull();

    // Outbox row also lives in the billing schema.
    const billingPubs = await billingDs.getRepository(EventPublicationEntity).find();
    expect(billingPubs).toHaveLength(1);
    expect(billingPubs[0]?.eventType).toBe('InvoicePaidEvent');

    await waitFor(() => billingProjections.observed.some((e) => e.invoiceId === 'inv-1'));
    const completed = await billingDs.getRepository(EventPublicationEntity).findOne({
      where: { id: billingPubs[0]!.id },
    });
    expect(completed?.status).toBe(PublicationStatus.COMPLETED);
  });

  it('inventory tx writes go to the inventory schema only', async () => {
    await inventory.placeReservation('res-1', 'sku-x', 3);

    const reservationsInInventory = await inventoryDs.query(
      'SELECT id FROM inventory.reservations ORDER BY id',
    );
    const reservationsInBilling = await billingDs.query(
      "SELECT to_regclass('billing.reservations') AS exists",
    );
    expect(reservationsInInventory).toEqual([{ id: 'res-1' }]);
    expect(reservationsInBilling[0].exists).toBeNull();

    await waitFor(() => inventoryProjections.observed.some((e) => e.reservationId === 'res-1'));
  });

  it('billing rollback discards both billing-schema rows; inventory schema untouched (DD-019 + DD-023)', async () => {
    await inventory.placeReservation('res-keepme', 'sku-keepme', 9);

    await expect(billing.payInvoiceAndFail('inv-x', 'bob', 9_999)).rejects.toThrow(
      'billing rollback',
    );

    const billingInvoices = await billingDs.getRepository(InvoiceRow).find();
    const billingPubs = await billingDs.getRepository(EventPublicationEntity).find();
    expect(billingInvoices).toHaveLength(0);
    expect(billingPubs).toHaveLength(0);

    // Inventory survives — separate schema, separate tx.
    const inventoryRows = await inventoryDs.getRepository(ReservationRow).find();
    expect(inventoryRows.map((r) => r.id)).toEqual(['res-keepme']);

    await waitFor(() =>
      inventoryProjections.observed.some((e) => e.reservationId === 'res-keepme'),
    );
    expect(billingProjections.observed.find((e) => e.invoiceId === 'inv-x')).toBeUndefined();
  });

  it('inventory rollback discards both inventory-schema rows; billing schema untouched', async () => {
    await billing.payInvoice('inv-keepme', 'carol', 1_500);

    await expect(inventory.placeReservationAndFail('res-x', 'sku-y', 1)).rejects.toThrow(
      'inventory rollback',
    );

    const inventoryReservations = await inventoryDs.getRepository(ReservationRow).find();
    const inventoryPubs = await inventoryDs.getRepository(EventPublicationEntity).find();
    expect(inventoryReservations).toHaveLength(0);
    expect(inventoryPubs).toHaveLength(0);

    const billingInvoices = await billingDs.getRepository(InvoiceRow).find();
    expect(billingInvoices.map((i) => i.id)).toEqual(['inv-keepme']);

    await waitFor(() => billingProjections.observed.some((e) => e.invoiceId === 'inv-keepme'));
  });
});
