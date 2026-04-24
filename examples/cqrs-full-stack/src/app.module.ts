import { type DynamicModule, Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { GetOrderHandler } from './get-order.handler';
import { OrderRow } from './order.entity';
import { OrderProjection } from './order.projection';
import { OrderRepository } from './order.repository';
import { PlaceOrderHandler } from './place-order.handler';

export async function createDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'sqljs',
    synchronize: true,
    entities: [OrderRow],
  });
  await ds.initialize();
  return ds;
}

@Module({})
export class AppModule {
  static forDataSource(dataSource: DataSource): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forFeature({ dataSource }),
        // Do NOT import @nestjs/cqrs's CqrsModule directly here —
        // CqrsTransactionalModule imports it internally and overrides
        // EventPublisher. Importing CqrsModule separately shadows the
        // override. See packages/cqrs/README.md for details.
        CqrsTransactionalModule.forRoot(),
      ],
      providers: [
        { provide: DataSource, useValue: dataSource },
        OrderRepository,
        PlaceOrderHandler,
        GetOrderHandler,
        OrderProjection,
      ],
    };
  }
}
