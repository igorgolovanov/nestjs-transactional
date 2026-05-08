import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule, readPostgresConfigFromEnv } from './app.module';
import { OrderService } from './order.service';
import { ShippingHandler } from './shipping.handler';

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
  const app = await NestFactory.createApplicationContext(AppModule.forPostgres(config), {
    logger: ['error', 'warn', 'log'],
  });

  const orders = app.get(OrderService);
  const shipping = app.get(ShippingHandler);

  console.log('=== basic-typeorm-outbox ===');

  console.log('1) placeOrder("o-1") — INSERT + outbox.publish in one tx');
  await orders.placeOrder('o-1', 'alice@example.com', 5_000);
  console.log('   orders in DB:', (await orders.listAll()).map((o) => o.id));

  await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-1'));
  console.log('   shipping handled:', shipping.handled.map((e) => e.orderId));

  console.log('2) placeOrderAndFail("o-2") — INSERT + publish, then throw');
  try {
    await orders.placeOrderAndFail('o-2', 'bob@example.com', 7_500);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log('   orders in DB (still):', (await orders.listAll()).map((o) => o.id));
  console.log('   shipping handled (still):', shipping.handled.map((e) => e.orderId));
  console.log('   expected: o-2 is in NEITHER list — both rows rolled back together');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
