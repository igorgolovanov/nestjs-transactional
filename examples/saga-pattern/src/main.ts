import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { AppModule, readPostgresConfigFromEnv } from './app.module';
import { OrderRow, PaymentRow, StockItemRow } from './entities';
import { OrderService } from './order.service';

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule.forConfig(readPostgresConfigFromEnv()),
    { logger: ['error', 'warn', 'log'] },
  );

  const ds = app.get<DataSource>(getDataSourceToken());
  const orders = app.get(OrderService);

  // Seed stock so all three demo orders have inventory available.
  await ds.manager.upsert(StockItemRow, [{ sku: 'WIDGET', available: 5 }], ['sku']);

  console.log('=== saga-pattern ===');

  console.log('1) place order #1 — happy path (amount below auth threshold)');
  await orders.placeOrder('ord-1', 'WIDGET', 1, 100);
  await waitFor(async () => (await ds.manager.findOneBy(OrderRow, { id: 'ord-1' }))?.status === 'shipped');
  console.log('   ord-1 status:', (await ds.manager.findOneBy(OrderRow, { id: 'ord-1' }))?.status);
  console.log('   stock left:', (await ds.manager.findOneBy(StockItemRow, { sku: 'WIDGET' }))?.available);

  console.log('2) place order #2 — payment fails (amount >= 10000), compensation restores stock');
  await orders.placeOrder('ord-2', 'WIDGET', 2, 12_000);
  await waitFor(async () => (await ds.manager.findOneBy(OrderRow, { id: 'ord-2' }))?.status === 'failed-payment');
  console.log('   ord-2 status:', (await ds.manager.findOneBy(OrderRow, { id: 'ord-2' }))?.status);
  console.log('   ord-2 payment:', (await ds.manager.findOneBy(PaymentRow, { orderId: 'ord-2' }))?.status);
  console.log('   stock after compensation:', (await ds.manager.findOneBy(StockItemRow, { sku: 'WIDGET' }))?.available);

  console.log('3) place order #3 — out of stock (request 10, only 4 left), reservation fails');
  await orders.placeOrder('ord-3', 'WIDGET', 10, 100);
  await waitFor(async () => (await ds.manager.findOneBy(OrderRow, { id: 'ord-3' }))?.status === 'failed-reservation');
  console.log('   ord-3 status:', (await ds.manager.findOneBy(OrderRow, { id: 'ord-3' }))?.status);
  console.log('   stock unchanged:', (await ds.manager.findOneBy(StockItemRow, { sku: 'WIDGET' }))?.available);

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
