import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { WorkflowClient } from '@nestjs/workflows';

import { AppModule } from './app.module.js';
import { readPostgresConfigFromEnv } from './database/database.module.js';
import { NotificationsHandler } from './notifications/notifications.handler.js';
import { OrdersService } from './orders/orders.service.js';
import { shippingId } from './shipping/ship-order.workflow.js';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule.forPostgres(readPostgresConfigFromEnv()),
    { logger: ['error', 'warn'] },
  );
  await app.init();

  const orders = app.get(OrdersService);
  const workflows = app.get(WorkflowClient);
  const notifications = app.get(NotificationsHandler);
  const run = Date.now().toString(36);

  const show = async (orderId: string): Promise<void> => {
    const order = await orders.find(orderId);
    const workflow = (await workflows.getStatus(shippingId(orderId))) as { status?: string } | null;
    console.log(`   order ${orderId}: ${order?.status ?? 'not in the database'}`);
    console.log(`   workflow: ${workflow?.status ?? 'none'}`);
  };

  console.log('=== drizzle-orders ===\n');

  const ok = `o-1-${run}`;
  console.log(`1) place(${ok}): one @Transactional method writes the order through the`);
  console.log('   injected Drizzle db, adds an outbox message and starts a workflow,');
  console.log('   with no transaction passed anywhere');
  await orders.place(ok, 'book', 2_500);
  await show(ok);

  console.log('\n2) The worker runs the workflow: book a courier, mark the order shipped');
  const tracking = await workflows.result(shippingId(ok), { timeout: '20s' });
  await show(ok);
  console.log(`   tracking: ${String(tracking)}`);

  const failed = `o-2-${run}`;
  console.log(`\n3) place(${failed}) throws after writing: all three roll back`);
  await orders.place(failed, 'book', 2_500, true).catch(() => undefined);
  await show(failed);

  await pause(500);
  console.log(`\n4) Delivered from the outbox after each commit:`);
  for (const line of notifications.sent) {
    console.log(`   ${line}`);
  }

  await app.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
