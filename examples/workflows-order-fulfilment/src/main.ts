import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { CommandBus } from '@nestjs/cqrs';
import { WorkflowClient } from '@nestjs/workflows';

import { AnalyticsProjection } from './analytics/analytics.projection.js';
import { AppModule, readPostgresConfigFromEnv } from './app.module.js';
import { PaymentsService } from './fakes/payments.service.js';
import { fulfilmentId } from './fulfilment/fulfil-order.workflow.js';
import { OrdersService } from './orders/orders.service.js';
import { PlaceOrderCommand } from './orders/place-order.handler.js';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule.forPostgres(readPostgresConfigFromEnv()),
    { logger: ['error', 'warn'] },
  );
  await app.init();

  const commands = app.get(CommandBus);
  const orders = app.get(OrdersService);
  const workflows = app.get(WorkflowClient);
  const analytics = app.get(AnalyticsProjection);
  const run = Date.now().toString(36);
  const id = (name: string): string => `${name}-${run}`;

  const status = async (orderId: string): Promise<string> =>
    ((await workflows.getStatus(fulfilmentId(orderId))) as { status?: string } | null)?.status ??
    'no workflow';
  const until = async (orderId: string, expected: string): Promise<void> => {
    for (let i = 0; i < 200 && (await status(orderId)) !== expected; i++) {
      await pause(50);
    }
  };
  const show = async (orderId: string): Promise<void> => {
    const order = await orders.find(orderId);
    console.log(`   order ${orderId}: ${order?.status ?? 'not in the database'}`);
    console.log(`   workflow: ${await status(orderId)}`);
  };

  console.log('=== workflows-order-fulfilment ===\n');

  const ok = id('o-1');
  console.log(`1) PlaceOrderCommand(${ok}): one @Transactional method saves the order;`);
  console.log('   order.commit() starts the workflow (@StartOn) and adds an outbox message,');
  console.log('   all in the same transaction, with no transaction passed anywhere');
  await commands.execute(new PlaceOrderCommand(ok, 'book', 1, 2_500));
  await show(ok);

  console.log('\n2) The worker runs the workflow: charge, reserve stock, mark paid,');
  console.log('   then park on the delivery signal');
  await until(ok, 'suspended');
  await show(ok);
  await pause(300);
  console.log(`   analytics, from the outbox: ${analytics.seen.join(', ')}`);

  const failed = id('o-2');
  console.log(`\n3) PlaceOrderCommand(${failed}) throws after writing: everything rolls back`);
  await commands
    .execute(new PlaceOrderCommand(failed, 'book', 1, 2_500, true))
    .catch(() => undefined);
  await show(failed);

  console.log(`\n4) The delivery webhook for ${ok} fails after signalling: the signal rolls back`);
  await orders.confirmDelivery(ok, 'ups', true).catch(() => undefined);
  await pause(500);
  await show(ok);

  console.log(`\n5) The delivery webhook for ${ok} succeeds: status and signal commit together`);
  await orders.confirmDelivery(ok, 'ups');
  const result = await workflows.result(fulfilmentId(ok), { timeout: '20s' });
  await show(ok);
  console.log(`   result: ${JSON.stringify(result)}`);

  const short = id('o-3');
  console.log(`\n6) PlaceOrderCommand(${short}) for an item out of stock: the reservation fails`);
  console.log('   for good, and the compensations run in reverse: refund, cancel');
  await commands.execute(new PlaceOrderCommand(short, 'out-of-stock', 1, 4_000));
  await until(short, 'failed');
  await show(short);
  const refunded = [...app.get(PaymentsService).charges.values()].some(
    (charge) => charge.orderId === short && charge.refunded,
  );
  console.log(`   charge refunded: ${refunded}`);

  await app.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
