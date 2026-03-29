import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { AppModule } from './app.module';
import { BillingService } from './billing.service';
import { InventoryService } from './inventory.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const billing = app.get(BillingService);
  const inventory = app.get(InventoryService);

  console.log('=== multi-datasource-basic ===');

  console.log('1) createInvoice("inv-1") — @Transactional() → default (billing) adapter');
  await billing.createInvoice('inv-1', 'alice', 5_000);

  console.log('2) upsertStock("sku-1") — @Transactional({ dataSource: "inventory" })');
  await inventory.upsertStock('sku-1', 12);

  console.log('');
  console.log('billing rows:', (await billing.listAll()).map((i) => i.id));
  console.log('inventory rows:', (await inventory.listAll()).map((s) => s.sku));

  console.log('');
  console.log('Cross-check isolation — neither DB knows the other\'s entity:');
  const billingDs = app.get<DataSource>(getDataSourceToken());
  const inventoryDs = app.get<DataSource>(getDataSourceToken('inventory'));
  const billingHasStock = await billingDs.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='stock_items'",
  );
  const inventoryHasInvoices = await inventoryDs.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='invoices'",
  );
  console.log('   billing has `stock_items` table?', billingHasStock.length > 0);
  console.log('   inventory has `invoices` table?', inventoryHasInvoices.length > 0);

  console.log('');
  console.log('3) upsertStockAndFail("sku-2") — inventory tx rolls back, billing untouched');
  try {
    await inventory.upsertStockAndFail('sku-2', 99);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  console.log('   billing rows (still):', (await billing.listAll()).map((i) => i.id));
  console.log('   inventory rows (sku-2 absent):', (await inventory.listAll()).map((s) => s.sku));

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
