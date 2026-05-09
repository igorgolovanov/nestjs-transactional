import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { CommandBus } from '@nestjs/cqrs';

import { AppModule } from './app.module';
import { BillingNotificationListener } from './billing.listener';
import { InventoryNotificationListener } from './inventory.listener';
import { IssueInvoiceCommand } from './issue-invoice.handler';
import { PlaceReservationCommand } from './place-reservation.handler';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const commandBus = app.get(CommandBus);
  const billing = app.get(BillingNotificationListener);
  const inventory = app.get(InventoryNotificationListener);

  console.log('=== multi-datasource-cqrs ===');

  console.log('1) IssueInvoiceCommand("inv-1") — billing tx commits, billing listener fires');
  await commandBus.execute(new IssueInvoiceCommand('inv-1', 'alice', 5_000));
  console.log('   billing notified:', billing.notified);
  console.log('   inventory notified (untouched):', inventory.notified);

  console.log('2) PlaceReservationCommand("res-1") — inventory tx commits (Phase 14.3.1 Cat B)');
  await commandBus.execute(new PlaceReservationCommand('res-1', 'sku-x', 3));
  console.log('   inventory notified:', inventory.notified);
  console.log('   billing notified (still):', billing.notified);

  console.log('3) IssueInvoiceCommand("inv-2", shouldFail=true) — billing rolls back');
  try {
    await commandBus.execute(new IssueInvoiceCommand('inv-2', 'bob', 7_500, true));
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  console.log('   billing notified (inv-2 absent):', billing.notified);

  console.log('4) PlaceReservationCommand("res-2", shouldFail=true) — inventory rolls back');
  try {
    await commandBus.execute(new PlaceReservationCommand('res-2', 'sku-y', 1, true));
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  console.log('   inventory notified (res-2 absent):', inventory.notified);
  console.log('   billing notified (still):', billing.notified);
  console.log('   expected: cross-DS rollback isolation — neither side affected (DD-023)');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
