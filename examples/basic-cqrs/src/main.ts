import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { CommandBus } from '@nestjs/cqrs';

import { AppModule } from './app.module';
import { NotificationHandler } from './notification.handler';
import { PlaceOrderCommand } from './place-order.handler';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const commandBus = app.get(CommandBus);
  const notifications = app.get(NotificationHandler);

  console.log('=== basic-cqrs ===');

  console.log('1) PlaceOrderCommand("o-1") — succeeds');
  await commandBus.execute(new PlaceOrderCommand('o-1'));
  console.log('   notified after commit:', notifications.notified);

  console.log('2) PlaceOrderCommand("o-2", shouldFail=true) — handler throws');
  try {
    await commandBus.execute(new PlaceOrderCommand('o-2', true));
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  console.log('   notified (still):', notifications.notified);
  console.log('   expected: o-2 is NOT in the list — AFTER_COMMIT skipped on rollback');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
