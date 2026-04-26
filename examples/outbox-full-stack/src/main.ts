import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { CommandBus } from '@nestjs/cqrs';
import { PublicationStatus } from '@nestjs-transactional/outbox';
import { EventPublicationEntity } from '@nestjs-transactional/outbox-typeorm';

import { AppModule, createDataSource, readPostgresConfigFromEnv } from './app.module';
import { OrderRepository } from './order.repository';
import { PlaceOrderCommand } from './place-order.handler';
import { ShippingHandlers } from './shipping.handler';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const dataSource = await createDataSource(readPostgresConfigFromEnv());

  // Clean slate — this is a demo, not a test harness.
  await dataSource.query('TRUNCATE TABLE event_publication_archive, event_publication, orders');

  const app = await NestFactory.createApplicationContext(AppModule.forDataSource(dataSource), {
    logger: ['error', 'warn', 'log'],
  });

  const commandBus = app.get(CommandBus);
  const orders = app.get(OrderRepository);
  const shipping = app.get(ShippingHandlers);

  console.log('');
  console.log('=== outbox-full-stack ===');

  console.log('');
  console.log('1) Happy path — CommandBus.execute(PlaceOrderCommand("order-1"))');
  await commandBus.execute(new PlaceOrderCommand('order-1'));

  // Right after the command returns, the business row is committed
  // and one PUBLISHED publication row exists for ShippingHandlers.
  const rowsAfterCommit = await dataSource.getRepository(EventPublicationEntity).find();
  console.log(
    `   DB rows: orders=${(await orders.listAll()).length}, ` +
      `event_publication=${rowsAfterCommit.length} (status=${rowsAfterCommit[0]?.status ?? '—'})`,
  );

  // The processor polls every 500ms in this example. Give it a beat
  // plus a margin for the REQUIRES_NEW transaction to complete.
  await sleep(1500);

  const rowsAfterWorker = await dataSource.getRepository(EventPublicationEntity).find();
  console.log(
    `   after worker: event_publication status=${rowsAfterWorker[0]?.status ?? '—'}`,
  );
  console.log(`   shipping handler invoked for: ${JSON.stringify(shipping.handled)}`);

  console.log('');
  console.log('2) Rollback path — CommandBus.execute(PlaceOrderCommand("order-2", shouldFail=true))');
  try {
    await commandBus.execute(new PlaceOrderCommand('order-2', true));
  } catch (err) {
    console.log(`   handler threw (expected): ${(err as Error).message}`);
  }

  await sleep(800);

  const allPublications = await dataSource.getRepository(EventPublicationEntity).find();
  const hasOrderTwo = allPublications.some((p) =>
    JSON.parse(p.serializedEvent).orderId === 'order-2',
  );
  console.log(
    `   publication for order-2? ${hasOrderTwo} (should be false — the transaction rolled back)`,
  );
  console.log(`   shipping handler state: ${JSON.stringify(shipping.handled)} (still only order-1)`);

  console.log('');
  console.log('3) Completion summary');
  const allAfter = await dataSource.getRepository(EventPublicationEntity).find();
  const byStatus: Record<string, number> = {};
  for (const row of allAfter) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  console.log(`   event_publication rows by status: ${JSON.stringify(byStatus)}`);
  const successful = allAfter.filter((p) => p.status === PublicationStatus.COMPLETED);
  console.log(`   successfully delivered: ${successful.length}`);

  await app.close();
  await dataSource.destroy();
}

main().catch((err) => {
  console.error('example failed:', err);
  process.exit(1);
});
