import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import { AppModule, createDataSource } from './app.module';
import { GetOrderQuery } from './get-order.handler';
import { OrderProjection } from './order.projection';
import { OrderRepository } from './order.repository';
import { PlaceOrderCommand } from './place-order.handler';

async function main(): Promise<void> {
  const dataSource = await createDataSource();
  const app = await NestFactory.createApplicationContext(AppModule.forDataSource(dataSource), {
    logger: ['error', 'warn', 'log'],
  });

  const commandBus = app.get(CommandBus);
  const queryBus = app.get(QueryBus);
  const projection = app.get(OrderProjection);
  const repo = app.get(OrderRepository);

  console.log('');
  console.log('=== cqrs-full-stack ===');

  console.log('1) CommandBus.execute(PlaceOrderCommand("order-1"))');
  await commandBus.execute(new PlaceOrderCommand('order-1'));
  console.log('   rows in DB:', (await repo.listAll()).map((o) => o.id));
  console.log('   projection.committed:', projection.committed);

  console.log('');
  console.log('2) QueryBus.execute(GetOrderQuery("order-1")) — wrapped as read-only tx by default');
  const loaded = await queryBus.execute(new GetOrderQuery('order-1'));
  console.log('   loaded:', loaded);

  console.log('');
  console.log('3) CommandBus.execute(PlaceOrderCommand("order-2", shouldFail=true))');
  try {
    await commandBus.execute(new PlaceOrderCommand('order-2', true));
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  console.log('   rows in DB:', (await repo.listAll()).map((o) => o.id));
  console.log('   projection.committed:', projection.committed);
  console.log('   projection.rolledBack:', projection.rolledBack);

  await app.close();
  await dataSource.destroy();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
