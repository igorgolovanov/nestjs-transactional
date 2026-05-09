import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import {
  AppModule,
  readMultiDsConfigFromEnv,
  readRabbitMqConfigFromEnv,
} from './app.module';
import { BillingPaymentHandler } from './billing.handler';
import { BillingService } from './billing.service';
import { InventoryAllocationHandler } from './inventory.handler';
import { InventoryService } from './inventory.service';

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const postgres = readMultiDsConfigFromEnv();
  const rabbitmq = readRabbitMqConfigFromEnv();

  const app = await NestFactory.createApplicationContext(
    AppModule.forConfig(postgres, rabbitmq),
    { logger: ['error', 'warn', 'log'] },
  );

  const billing = app.get(BillingService);
  const inventory = app.get(InventoryService);
  const billingHandler = app.get(BillingPaymentHandler);
  const inventoryHandler = app.get(InventoryAllocationHandler);

  console.log('=== externalization-multi-datasource ===');

  console.log('1) payInvoice("inv-1") — billing DS, BILLING_BROKER queue billing.events');
  await billing.payInvoice('inv-1', 'alice@example.com', 5_000);
  await waitFor(() => billingHandler.handled.some((e) => e.invoiceId === 'inv-1'));
  console.log('   billing local handled:', billingHandler.handled.map((e) => e.invoiceId));

  console.log('2) placeReservation("res-1") — inventory DS, INVENTORY_BROKER queue inventory.events');
  await inventory.placeReservation('res-1', 'sku-A', 10);
  await waitFor(() => inventoryHandler.handled.some((e) => e.reservationId === 'res-1'));
  console.log('   inventory local handled:', inventoryHandler.handled.map((e) => e.reservationId));

  console.log('3) Cross-DS isolation: billing rollback never touches inventory');
  try {
    await billing.payInvoice('inv-x', 'bob@example.com', 9_999, true);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log('   billing in DB:', (await billing.listAll()).map((i) => i.id));
  console.log('   inventory in DB (untouched):', (await inventory.listAll()).map((r) => r.id));

  console.log('4) Inventory rollback never touches billing');
  try {
    await inventory.placeReservation('res-x', 'sku-Z', 99, true);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log('   billing in DB (untouched):', (await billing.listAll()).map((i) => i.id));
  console.log('   inventory in DB:', (await inventory.listAll()).map((r) => r.id));

  console.log('expected: each broker received only its own DS\'s events; rollbacks isolated');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
