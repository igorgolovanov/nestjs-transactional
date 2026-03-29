import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { AppModule } from '../src/app.module';
import { BillingService } from '../src/billing.service';
import { InventoryService } from '../src/inventory.service';

describe('multi-datasource-basic', () => {
  let module: TestingModule;
  let billing: BillingService;
  let inventory: InventoryService;

  beforeEach(async () => {
    // Multi-`forRoot` dedup uses static class storage — must reset
    // between tests when each test rebuilds the module from scratch.
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.init();
    billing = module.get(BillingService);
    inventory = module.get(InventoryService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('routes @Transactional() to the default (billing) DataSource', async () => {
    await billing.createInvoice('inv-1', 'alice', 5_000);

    const ids = (await billing.listAll()).map((i) => i.id);
    expect(ids).toContain('inv-1');

    // Inventory DS unaffected — no rows leaked across.
    expect(await inventory.listAll()).toHaveLength(0);
  });

  it('routes @Transactional({ dataSource: "inventory" }) to the inventory DataSource', async () => {
    await inventory.upsertStock('sku-1', 12);

    const skus = (await inventory.listAll()).map((s) => s.sku);
    expect(skus).toContain('sku-1');

    // Billing DS unaffected — no rows leaked across.
    expect(await billing.listAll()).toHaveLength(0);
  });

  it('rolls back the inventory transaction without touching billing (DD-023 cross-DS isolation)', async () => {
    await billing.createInvoice('inv-2', 'bob', 7_500);

    await expect(inventory.upsertStockAndFail('sku-2', 99)).rejects.toThrow(
      'simulated inventory failure — should roll back',
    );

    expect((await billing.listAll()).map((i) => i.id)).toContain('inv-2');
    expect((await inventory.listAll()).map((s) => s.sku)).not.toContain('sku-2');
  });

  it('rolls back the billing transaction without touching inventory', async () => {
    await inventory.upsertStock('sku-3', 5);

    await expect(billing.createInvoiceAndFail('inv-3', 'carol', 3_000)).rejects.toThrow(
      'simulated billing failure — should roll back',
    );

    expect((await inventory.listAll()).map((s) => s.sku)).toContain('sku-3');
    expect((await billing.listAll()).map((i) => i.id)).not.toContain('inv-3');
  });

  it('keeps multiple successful writes across both DataSources', async () => {
    await billing.createInvoice('inv-4', 'dani', 1_000);
    await billing.createInvoice('inv-5', 'eve', 2_000);
    await inventory.upsertStock('sku-4', 1);
    await inventory.upsertStock('sku-5', 2);

    expect((await billing.listAll()).map((i) => i.id).sort()).toEqual(['inv-4', 'inv-5']);
    expect((await inventory.listAll()).map((s) => s.sku).sort()).toEqual(['sku-4', 'sku-5']);
  });
});
