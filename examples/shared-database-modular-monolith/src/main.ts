import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';

import { AppModule, readPostgresConfigFromEnv } from './app.module';
import { BillingService } from './billing/billing.service';
import { BillingPaymentProjectionListener } from './billing/billing.listener';
import { InventoryService } from './inventory/inventory.service';
import { InventoryShipmentProjectionListener } from './inventory/inventory.listener';

async function ensureSchemas(config: ReturnType<typeof readPostgresConfigFromEnv>): Promise<void> {
  const admin = new Client(config);
  await admin.connect();
  await admin.query('CREATE SCHEMA IF NOT EXISTS billing');
  await admin.query('CREATE SCHEMA IF NOT EXISTS inventory');
  await admin.end();
}

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
  const config = readPostgresConfigFromEnv();
  await ensureSchemas(config);

  const app = await NestFactory.createApplicationContext(AppModule.forPostgres(config), {
    logger: ['error', 'warn', 'log'],
  });

  const billing = app.get(BillingService);
  const inventory = app.get(InventoryService);
  const billingProjections = app.get(BillingPaymentProjectionListener);
  const inventoryProjections = app.get(InventoryShipmentProjectionListener);

  console.log('=== shared-database-modular-monolith ===');

  console.log('1) billing.payInvoice("inv-1") — billing schema tx, billing outbox row');
  await billing.payInvoice('inv-1', 'alice', 5_000);
  await waitFor(() => billingProjections.observed.some((e) => e.invoiceId === 'inv-1'));
  console.log('   billing observed:', billingProjections.observed.map((e) => e.invoiceId));

  console.log('2) inventory.placeReservation("res-1") — inventory schema tx, inventory outbox row');
  await inventory.placeReservation('res-1', 'sku-x', 3);
  await waitFor(() => inventoryProjections.observed.some((e) => e.reservationId === 'res-1'));
  console.log(
    '   inventory observed:',
    inventoryProjections.observed.map((e) => e.reservationId),
  );

  console.log('3) billing rollback — schema-level atomicity');
  try {
    await billing.payInvoiceAndFail('inv-2', 'bob', 7_500);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 300));
  console.log(
    '   billing observed (still):',
    billingProjections.observed.map((e) => e.invoiceId),
  );
  console.log('   expected: inv-2 absent — billing.invoices and billing.event_publication both rolled back');

  console.log('4) inventory rollback — billing schema untouched');
  try {
    await inventory.placeReservationAndFail('res-2', 'sku-y', 1);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 300));
  console.log(
    '   inventory observed (still):',
    inventoryProjections.observed.map((e) => e.reservationId),
  );
  console.log(
    '   billing observed (still):',
    billingProjections.observed.map((e) => e.invoiceId),
  );
  console.log('   expected: cross-schema rollback isolation per DD-023');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
