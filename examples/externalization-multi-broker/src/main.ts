import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import {
  AppModule,
  readBrokerConfigFromEnv,
  readPostgresConfigFromEnv,
} from './app.module';
import { AccountingHandler } from './accounting.handler';
import { LocalCacheInvalidator } from './local-cache.handler';
import { OrderService } from './order.service';
import { ShippingHandler } from './shipping.handler';

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
  const postgres = readPostgresConfigFromEnv();
  const brokers = readBrokerConfigFromEnv();

  const app = await NestFactory.createApplicationContext(
    AppModule.forInfrastructure(postgres, brokers),
    { logger: ['error', 'warn', 'log'] },
  );

  const orders = app.get(OrderService);
  const shipping = app.get(ShippingHandler);
  const accounting = app.get(AccountingHandler);
  const cache = app.get(LocalCacheInvalidator);

  console.log('=== externalization-multi-broker ===');

  console.log('1) placeOrder("o-1") with refund — three publications, three brokers:');
  console.log('   - OrderPlacedEvent → Kafka (orders.placed)');
  console.log('   - RefundRequestedEvent → RabbitMQ (refunds queue)');
  console.log('   - CacheInvalidationEvent → Redis (cache.invalidated)');
  await orders.placeOrder('o-1', 'alice@example.com', 5_000, { refundCents: 1_500 });

  console.log('   waiting for local handlers...');
  await waitFor(
    () =>
      shipping.handled.some((e) => e.orderId === 'o-1') &&
      accounting.handled.some((e) => e.orderId === 'o-1') &&
      cache.handled.some((e) => e.key === 'customer:alice@example.com:pricing'),
  );
  console.log('   shipping handled:', shipping.handled.map((e) => e.orderId));
  console.log('   accounting handled:', accounting.handled.map((e) => e.refundId));
  console.log('   cache invalidated:', cache.handled.map((e) => e.key));

  console.log('   externalizer dispatched all three events to their respective brokers');
  console.log('   (verify via the brokers themselves — Kafka topic, RabbitMQ queue, Redis channel)');

  console.log('2) placeOrder fail — atomicity gate covers ALL three brokers:');
  try {
    await orders.placeOrder('o-2', 'bob@example.com', 7_500, { refundCents: 2_000, fail: true });
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }

  await new Promise((r) => setTimeout(r, 500));
  console.log('   orders in DB:', (await orders.listAll()).map((o) => o.id));
  console.log('   shipping handled:', shipping.handled.map((e) => e.orderId));
  console.log('   accounting handled:', accounting.handled.map((e) => e.refundId));
  console.log('   cache handled:', cache.handled.map((e) => e.key));
  console.log('   expected: o-2 / refund-o-2 NOT present anywhere — atomicity holds');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
