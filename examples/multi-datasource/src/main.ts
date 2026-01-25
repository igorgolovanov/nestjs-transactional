import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule, createDataSources } from './app.module';
import { BillingService } from './billing.service';
import { OrderService } from './order.service';

async function main(): Promise<void> {
  const { primary, billing } = await createDataSources();
  const app = await NestFactory.createApplicationContext(
    AppModule.forDataSources(primary, billing),
    { logger: ['error', 'warn', 'log'] },
  );

  const orders = app.get(OrderService);
  const invoices = app.get(BillingService);

  console.log('=== multi-datasource ===');

  console.log('1) placeOrder("order-1") — @Transactional() → default (primary) adapter');
  await orders.placeOrder('order-1', 'alice');

  console.log('2) generateInvoice("inv-1") — @TransactionalOn("billing") → billing adapter');
  await invoices.generateInvoice('inv-1', 'order-1', 999);

  console.log('');
  console.log('Primary DS tables (orders):', (await orders.listAll()).map((o) => o.id));
  console.log('Billing DS tables (invoices):', (await invoices.listAll()).map((i) => i.id));

  console.log('');
  console.log('Cross-check isolation — neither DB knows the other\'s entity:');
  const primaryHasInvoices = await primary.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='invoices'",
  );
  const billingHasOrders = await billing.query(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='orders'",
  );
  console.log('   primary has `invoices` table?', primaryHasInvoices.length > 0);
  console.log('   billing has `orders` table?', billingHasOrders.length > 0);

  await app.close();
  await primary.destroy();
  await billing.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
