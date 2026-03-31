import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { CommandBus } from '@nestjs/cqrs';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { AppModule } from '../src/app.module';
import { BillingNotificationListener } from '../src/billing.listener';
import { InventoryNotificationListener } from '../src/inventory.listener';
import { IssueInvoiceCommand } from '../src/issue-invoice.handler';
import { PlaceReservationCommand } from '../src/place-reservation.handler';

describe('multi-datasource-cqrs (Phase 14.3.1 Category B)', () => {
  let module: TestingModule;
  let commandBus: CommandBus;
  let billing: BillingNotificationListener;
  let inventory: InventoryNotificationListener;

  beforeEach(async () => {
    // Multi-`forRoot` dedup uses static class storage — reset between
    // tests when each test rebuilds the module from scratch.
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.init();

    commandBus = module.get(CommandBus);
    billing = module.get(BillingNotificationListener);
    inventory = module.get(InventoryNotificationListener);
  });

  afterEach(async () => {
    await module.close();
  });

  it('routes the AFTER_COMMIT hook for the billing aggregate to the billing DS', async () => {
    await commandBus.execute(new IssueInvoiceCommand('inv-1', 'alice', 5_000));

    expect(billing.notified).toEqual(['inv-1']);
    expect(inventory.notified).toEqual([]);
  });

  it('routes the AFTER_COMMIT hook for the inventory aggregate to the inventory DS via dataSource option', async () => {
    await commandBus.execute(new PlaceReservationCommand('res-1', 'sku-x', 3));

    expect(inventory.notified).toEqual(['res-1']);
    expect(billing.notified).toEqual([]);
  });

  it('skips the billing AFTER_COMMIT hook on rollback (atomicity within billing DS)', async () => {
    await expect(
      commandBus.execute(new IssueInvoiceCommand('inv-x', 'bob', 9_999, true)),
    ).rejects.toThrow('billing rollback');

    expect(billing.notified).not.toContain('inv-x');
    expect(inventory.notified).toEqual([]);
  });

  it('skips the inventory AFTER_COMMIT hook on rollback; billing untouched (DD-023 cross-DS isolation)', async () => {
    await commandBus.execute(new IssueInvoiceCommand('inv-keepme', 'carol', 1_500));

    await expect(
      commandBus.execute(new PlaceReservationCommand('res-x', 'sku-y', 1, true)),
    ).rejects.toThrow('inventory rollback');

    // Billing's earlier successful publication still fired.
    expect(billing.notified).toEqual(['inv-keepme']);
    // Inventory's failed publication is silenced.
    expect(inventory.notified).not.toContain('res-x');
  });

  it('keeps independent dispatch queues — multiple commands across DSes accumulate per-DS', async () => {
    await commandBus.execute(new IssueInvoiceCommand('inv-2', 'dani', 1_000));
    await commandBus.execute(new PlaceReservationCommand('res-2', 'sku-a', 5));
    await commandBus.execute(new IssueInvoiceCommand('inv-3', 'eve', 2_000));
    await commandBus.execute(new PlaceReservationCommand('res-3', 'sku-b', 7));

    expect(billing.notified.sort()).toEqual(['inv-2', 'inv-3']);
    expect(inventory.notified.sort()).toEqual(['res-2', 'res-3']);
  });
});
