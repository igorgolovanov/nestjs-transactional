import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { OrderService } from './order.service';
import { ShippingHandler } from './shipping.handler';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const orders = app.get(OrderService);
  const shipping = app.get(ShippingHandler);

  console.log('=== basic-outbox ===');

  console.log('1) placeOrder("o-1") inside @Transactional + outbox.publish');
  await orders.placeOrder('o-1', 'alice@example.com');
  await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-1'));
  console.log('   shipping handled:', shipping.handled.map((e) => e.orderId));

  console.log('2) placeOrderAndFail("o-2") — service throws after publish');
  try {
    await orders.placeOrderAndFail('o-2', 'bob@example.com');
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }

  // Give the worker a moment to confirm `o-2` is NOT delivered.
  await new Promise((r) => setTimeout(r, 200));
  console.log('   shipping handled (still):', shipping.handled.map((e) => e.orderId));
  console.log('   expected: o-2 is NOT delivered — publish rolled back with the tx');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
