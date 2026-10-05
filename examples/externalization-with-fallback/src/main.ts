import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { type OutboxEnvelope, OutboxDeadLetters, OutboxRelay } from '@nestjs/outbox';

import { AppModule, readPostgresConfigFromEnv, readRabbitMqConfigFromEnv } from './app.module.js';
import { RefundConsumerService } from './refund-consumer.service.js';
import type { RefundRequestedEvent } from './refund-requested.event.js';
import { RefundService } from './refund.service.js';

async function main(): Promise<void> {
  const postgres = readPostgresConfigFromEnv();
  const rabbitmq = readRabbitMqConfigFromEnv();

  const app = await NestFactory.createApplicationContext(
    AppModule.forInfrastructure(postgres, rabbitmq),
    { logger: ['error', 'warn', 'log'] },
  );

  const refunds = app.get(RefundService);
  const consumer = app.get(RefundConsumerService);
  const relay = app.get(OutboxRelay);
  const deadLetters = app.get(OutboxDeadLetters);

  console.log('=== externalization-with-fallback ===');

  console.log('1) requestRefund("rf-1") — refund row + outbox message in one transaction');
  await refunds.requestRefund('rf-1', 'order-1', 1_500);
  await new Promise((r) => setTimeout(r, 1_000));
  console.log('   relay stats:', await relay.stats());
  console.log('   With the broker up, the message has been delivered and left the outbox.');

  console.log('2) Stop RabbitMQ now (docker compose stop rabbitmq) to watch the fallback:');
  console.log('   the message stays in the outbox, is retried with backoff, and after');
  console.log('   three attempts is dead-lettered with its error history.');

  console.log('3) Recovery — requeue dead letters once the broker is back');
  const dead = await deadLetters.list();
  console.log(`   ${dead.length} dead letter(s).`);
  if (dead.length > 0) {
    console.log(`   Requeued ${await deadLetters.requeue(dead.map((d) => d.id))} for delivery.`);
  }

  console.log('4) Consumer-side inbox — the same message twice');
  const envelope: OutboxEnvelope<RefundRequestedEvent> = {
    id: 'demo-message-rf-3',
    topic: 'refunds',
    key: null,
    headers: {},
    createdAt: Date.now(),
    payload: { refundId: 'rf-3', orderId: 'order-3', amountCents: 500 },
  };
  console.log('   first delivery: ', await consumer.process(envelope));
  console.log('   second delivery:', await consumer.process(envelope));
  console.log('   The inbox keeps the effect to one, however many times it arrives.');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
