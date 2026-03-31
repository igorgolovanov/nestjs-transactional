import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule, readMultiDsConfigFromEnv } from './app.module';
import { BillingService } from './billing.service';
import { BillingProjectionsHandler } from './billing.handler';
import { InventoryService } from './inventory.service';
import { InventoryProjectionsHandler } from './inventory.handler';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const config = readMultiDsConfigFromEnv();
  const app = await NestFactory.createApplicationContext(AppModule.forConfig(config), {
    logger: ['error', 'warn', 'log'],
  });

  const billing = app.get(BillingService);
  const inventory = app.get(InventoryService);
  const billingProjections = app.get(BillingProjectionsHandler);
  const inventoryProjections = app.get(InventoryProjectionsHandler);

  console.log('=== multi-datasource-outbox ===');

  console.log('1) createInvoice("inv-1") — billing tx writes invoice + publication atomically');
  await billing.createInvoice('inv-1', 'alice', 5_000);
  await waitFor(() => billingProjections.handled.some((e) => e.invoiceId === 'inv-1'));
  console.log('   billing handler invoked:', billingProjections.handled.map((e) => e.invoiceId));

  console.log('2) adjustStock("sku-1") — inventory tx, separate DB, independent worker');
  await inventory.adjustStock('sku-1', 12);
  await waitFor(() => inventoryProjections.handled.some((e) => e.sku === 'sku-1'));
  console.log('   inventory handler invoked:', inventoryProjections.handled.map((e) => e.sku));

  console.log('3) createInvoiceAndFail("inv-2") — billing rolls back; both rows discarded');
  try {
    await billing.createInvoiceAndFail('inv-2', 'bob', 7_500);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  // Worker waits a moment to confirm the row is NOT delivered.
  await new Promise((r) => setTimeout(r, 300));
  console.log('   billing handler (still):', billingProjections.handled.map((e) => e.invoiceId));
  console.log('   expected: inv-2 absent — atomicity (DD-019) within billing DS');

  console.log('4) adjustStockAndFail("sku-2") — inventory rolls back; billing untouched');
  try {
    await inventory.adjustStockAndFail('sku-2', 99);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 300));
  console.log('   inventory handler (still):', inventoryProjections.handled.map((e) => e.sku));
  console.log('   billing handler (still):', billingProjections.handled.map((e) => e.invoiceId));
  console.log('   expected: cross-DS isolation — neither side affected by the other (DD-023)');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
