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
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { BillingProjectionsHandler } from '../src/billing.handler';
import { BillingService } from '../src/billing.service';
import { InvoiceEntity, StockItemEntity } from '../src/entities';
import { InventoryProjectionsHandler } from '../src/inventory.handler';
import { InventoryService } from '../src/inventory.service';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('multi-datasource-outbox (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let billingDs: DataSource;
  let inventoryDs: DataSource;
  let module: TestingModule;
  let billing: BillingService;
  let inventory: InventoryService;
  let billingProjections: BillingProjectionsHandler;
  let inventoryProjections: InventoryProjectionsHandler;

  beforeAll(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // Create the inventory database via the container's psql admin
    // connection. testcontainers' default user has CREATEDB privilege.
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

    module = await Test.createTestingModule({
      imports: [
        AppModule.forConfig({
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
        }),
      ],
    }).compile();

    // Worker may briefly observe rolled-back rows during the rollback
    // tests below — its `markFailed` then errors on a missing row.
    // Expected noise; suppress all log levels for the suite.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await module.init();

    billingDs = module.get<DataSource>(getDataSourceToken());
    inventoryDs = module.get<DataSource>(getDataSourceToken('inventory'));
    billing = module.get(BillingService);
    inventory = module.get(InventoryService);
    billingProjections = module.get(BillingProjectionsHandler);
    inventoryProjections = module.get(InventoryProjectionsHandler);
  }, 90_000);

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
    await inventoryDs.getRepository(StockItemEntity).clear();
    billingProjections.handled.length = 0;
    inventoryProjections.handled.length = 0;
  });

  it('billing tx commits invoice + publication into the billing DB only', async () => {
    await billing.createInvoice('inv-1', 'alice', 5_000);

    const billingInvoices = await billingDs.getRepository(InvoiceEntity).find();
    const billingPubs = await billingDs.getRepository(EventPublicationEntity).find();
    const inventoryPubs = await inventoryDs.getRepository(EventPublicationEntity).find();

    expect(billingInvoices.map((i) => i.id)).toEqual(['inv-1']);
    expect(billingPubs).toHaveLength(1);
    expect(billingPubs[0]?.eventType).toBe('InvoiceCreatedEvent');
    // Inventory DB completely untouched — atomicity scoped per dataSource.
    expect(inventoryPubs).toHaveLength(0);

    // Worker delivers and marks COMPLETED.
    await waitFor(() => billingProjections.handled.some((e) => e.invoiceId === 'inv-1'));
    const completed = await billingDs.getRepository(EventPublicationEntity).findOne({
      where: { id: billingPubs[0]!.id },
    });
    expect(completed?.status).toBe(PublicationStatus.COMPLETED);
  });

  it('inventory tx commits stock + publication into the inventory DB only', async () => {
    await inventory.adjustStock('sku-1', 12);

    const stockRows = await inventoryDs.getRepository(StockItemEntity).find();
    const inventoryPubs = await inventoryDs.getRepository(EventPublicationEntity).find();
    const billingPubs = await billingDs.getRepository(EventPublicationEntity).find();

    expect(stockRows.map((s) => s.sku)).toEqual(['sku-1']);
    expect(inventoryPubs).toHaveLength(1);
    expect(inventoryPubs[0]?.eventType).toBe('StockAdjustedEvent');
    expect(billingPubs).toHaveLength(0);

    await waitFor(() => inventoryProjections.handled.some((e) => e.sku === 'sku-1'));
  });

  it('billing rollback discards both invoice + publication; inventory untouched (DD-019 + DD-023)', async () => {
    await inventory.adjustStock('sku-keepme', 7);

    await expect(billing.createInvoiceAndFail('inv-x', 'bob', 9_999)).rejects.toThrow(
      'simulated billing failure',
    );

    const billingInvoices = await billingDs.getRepository(InvoiceEntity).find();
    const billingPubs = await billingDs.getRepository(EventPublicationEntity).find();
    const stockRows = await inventoryDs.getRepository(StockItemEntity).find();
    const inventoryPubs = await inventoryDs.getRepository(EventPublicationEntity).find();

    // Billing: nothing persisted — single-unit atomicity.
    expect(billingInvoices).toHaveLength(0);
    expect(billingPubs).toHaveLength(0);

    // Inventory: untouched by billing's failure — cross-DS isolation.
    expect(stockRows.map((s) => s.sku)).toEqual(['sku-keepme']);
    expect(inventoryPubs).toHaveLength(1);

    // Eventually the inventory event is delivered (it survived).
    await waitFor(() => inventoryProjections.handled.some((e) => e.sku === 'sku-keepme'));
    expect(billingProjections.handled.find((e) => e.invoiceId === 'inv-x')).toBeUndefined();
  });

  it('inventory rollback discards both stock + publication; billing untouched', async () => {
    await billing.createInvoice('inv-keepme', 'carol', 1_500);

    await expect(inventory.adjustStockAndFail('sku-x', 0)).rejects.toThrow(
      'simulated inventory failure',
    );

    const stockRows = await inventoryDs.getRepository(StockItemEntity).find();
    const inventoryPubs = await inventoryDs.getRepository(EventPublicationEntity).find();
    const billingInvoices = await billingDs.getRepository(InvoiceEntity).find();

    expect(stockRows).toHaveLength(0);
    expect(inventoryPubs).toHaveLength(0);
    expect(billingInvoices.map((i) => i.id)).toEqual(['inv-keepme']);

    await waitFor(() => billingProjections.handled.some((e) => e.invoiceId === 'inv-keepme'));
  });
});
