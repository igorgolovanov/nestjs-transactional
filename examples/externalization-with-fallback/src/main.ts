import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FailedEventPublications } from '@nestjs-transactional/outbox';

import {
  AppModule,
  readPostgresConfigFromEnv,
  readRabbitMqConfigFromEnv,
} from './app.module';
import { RefundConsumerService } from './refund-consumer.service';
import { RefundLedgerHandler } from './refund-ledger.handler';
import { RefundRequestedEvent } from './refund-requested.event';
import { RefundService } from './refund.service';

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
  const rabbitmq = readRabbitMqConfigFromEnv();

  const app = await NestFactory.createApplicationContext(
    AppModule.forInfrastructure(postgres, rabbitmq),
    { logger: ['error', 'warn', 'log'] },
  );

  const refunds = app.get(RefundService);
  const ledger = app.get(RefundLedgerHandler);
  const consumer = app.get(RefundConsumerService);
  const failed = app.get(FailedEventPublications);

  console.log('=== externalization-with-fallback ===');

  console.log('1) Happy path — broker reachable');
  await refunds.requestRefund('rf-1', 'order-1', 5_000);
  await waitFor(() => ledger.handled.some((e) => e.refundId === 'rf-1'));
  console.log('   ledger handled:', ledger.handled.map((e) => e.refundId));

  console.log('   The publication transitions to COMPLETED.');
  console.log('   Verify on RabbitMQ management UI: queue `refunds` should have a message.');

  console.log('2) ADR-016 silent-success demo');
  console.log('   ACTION REQUIRED — in another terminal, stop RabbitMQ:');
  console.log(
    '     docker-compose -f examples/externalization-with-fallback/docker-compose.yml stop rabbitmq',
  );
  console.log('   Press ENTER when done...');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));

  await refunds.requestRefund('rf-2', 'order-2', 7_500);
  await waitFor(() => ledger.handled.some((e) => e.refundId === 'rf-2'));
  console.log('   ledger handled:', ledger.handled.map((e) => e.refundId));

  // Give the externalizer a moment to "succeed" (it won't surface the
  // unreachable broker — that's the whole point).
  await new Promise((r) => setTimeout(r, 1_500));
  console.log('   The publication for rf-2 ALSO transitions to COMPLETED.');
  console.log('   Verify on RabbitMQ management UI: queue `refunds` got NO new message.');
  console.log('   This is the ADR-016 silent-success limitation in action.');

  console.log('3) Recovery from a SURFACED failure');
  console.log('   Restart the broker:');
  console.log(
    '     docker-compose -f examples/externalization-with-fallback/docker-compose.yml start rabbitmq',
  );
  console.log('   Press ENTER when ready...');
  await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));

  // The visual demo can't easily simulate a thrown emit at the proxy
  // level — the test does that via mocking. Instead just exercise
  // the operator API to show it works.
  const failedCount = await failed.count();
  console.log(`   Currently ${failedCount} publications in FAILED state.`);
  if (failedCount > 0) {
    const resubmitted = await failed.resubmit();
    console.log(`   Resubmitted ${resubmitted} for retry.`);
  } else {
    console.log('   Nothing to resubmit; see the integration test for the full failure flow.');
  }

  console.log('4) Consumer-side dedup template');
  const event = new RefundRequestedEvent('rf-3', 'order-3', 1_500);
  const result1 = await consumer.process(event, 'pub-rf-3');
  const result2 = await consumer.process(event, 'pub-rf-3');
  console.log(`   first call: ${result1}, second call: ${result2}`);
  console.log('   The dedup table guarantees at-most-once processing on the consumer side');
  console.log('   even when the broker (or our framework) delivers the same event twice.');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
