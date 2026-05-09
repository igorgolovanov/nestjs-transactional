import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Kafka } from 'kafkajs';

import {
  AppModule,
  readKafkaConfigFromEnv,
  readPostgresConfigFromEnv,
} from './app.module';
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
  const kafka = readKafkaConfigFromEnv();

  // Stand up an independent kafkajs consumer so the demo prints what
  // actually landed on the topic. Production consumers live in their
  // own services; this is just a visual proof.
  const consumer = new Kafka({
    clientId: 'externalization-kafka-demo-consumer',
    brokers: [...kafka.brokers],
  }).consumer({ groupId: 'externalization-kafka-demo' });

  const received: { key: string | undefined; value: string; headers: Record<string, string> }[] =
    [];

  await consumer.connect();
  await consumer.subscribe({ topic: 'orders.placed', fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {})) {
        if (v !== undefined) headers[k] = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
      }
      received.push({
        key: message.key?.toString('utf8'),
        value: message.value?.toString('utf8') ?? '',
        headers,
      });
    },
  });

  const app = await NestFactory.createApplicationContext(
    AppModule.forInfrastructure(postgres, kafka),
    { logger: ['error', 'warn', 'log'] },
  );

  const orders = app.get(OrderService);
  const shipping = app.get(ShippingHandler);

  console.log('=== externalization-kafka ===');

  console.log('1) placeOrder("o-1") — INSERT + outbox.publish in one tx');
  await orders.placeOrder('o-1', 'alice@example.com', 5_000);

  console.log('   waiting for local handler...');
  await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-1'));
  console.log('   shipping handled:', shipping.handled.map((e) => e.orderId));

  console.log('   waiting for kafka consumer...');
  await waitFor(() => received.some((m) => m.key === 'o-1'));
  console.log('   kafka received:');
  for (const m of received) {
    console.log(`     key=${m.key} headers=${JSON.stringify(m.headers)} value=${m.value}`);
  }

  console.log('2) placeOrderAndFail("o-2") — both rows roll back, no Kafka emit');
  try {
    await orders.placeOrderAndFail('o-2', 'bob@example.com', 7_500);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  await new Promise((r) => setTimeout(r, 1_000));
  console.log('   orders in DB:', (await orders.listAll()).map((o) => o.id));
  console.log('   shipping handled:', shipping.handled.map((e) => e.orderId));
  console.log('   kafka received keys:', received.map((m) => m.key));
  console.log('   expected: o-2 in NEITHER list — atomicity holds across externalization');

  await consumer.disconnect();
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
