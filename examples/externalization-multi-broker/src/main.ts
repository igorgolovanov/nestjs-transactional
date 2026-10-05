import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule, readBrokerConfigFromEnv, readPostgresConfigFromEnv } from './app.module.js';
import { OrderService } from './order.service.js';

async function main(): Promise<void> {
  const postgres = readPostgresConfigFromEnv();
  const brokers = readBrokerConfigFromEnv();

  const app = await NestFactory.createApplicationContext(
    AppModule.forInfrastructure(postgres, brokers),
    { logger: ['error', 'warn', 'log'] },
  );

  const orders = app.get(OrderService);

  console.log('=== externalization-multi-broker ===');

  console.log('1) placeOrder("o-1") with refund — three messages, three brokers:');
  console.log('   - OrderPlacedEvent → Kafka (orders.placed), keyed by order id');
  console.log('   - RefundRequestedEvent → RabbitMQ (refunds queue)');
  console.log('   - CacheInvalidationEvent → Redis (cache.invalidated)');
  await orders.placeOrder('o-1', 'alice@example.com', 5_000, { refundCents: 1_500 });
  await new Promise((r) => setTimeout(r, 1_000));
  console.log('   the relay has delivered them; check the brokers themselves');
  console.log('   (Kafka topic, RabbitMQ queue, Redis channel)');

  console.log('2) placeOrder fail — the rollback covers all three brokers:');
  try {
    await orders.placeOrder('o-2', 'bob@example.com', 7_500, { refundCents: 2_000, fail: true });
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  console.log(
    '   orders in DB:',
    (await orders.listAll()).map((o) => o.id),
  );
  console.log('   expected: o-2 absent, and no broker received anything for it');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
