import { type DynamicModule, Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { GetOrderHandler } from './get-order.handler';
import { OrderRow } from './order.entity';
import { OrderCommittedProjection, OrderRollbackProjection } from './order.projection';
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
        TypeOrmTransactionalModule.forRoot(),
        // Do NOT import @nestjs/cqrs's CqrsModule directly here —
        // CqrsTransactionalModule imports it internally and overrides
        // EventPublisher. Importing CqrsModule separately shadows the
        // override. See packages/cqrs/README.md for details.
        CqrsTransactionalModule.forRoot(),
      ],
      providers: [
        // Phase 14.20: typeorm forRoot resolves the DataSource via
        // `getDataSourceToken()`. Provide it explicitly here; in a
        // real app `TypeOrmModule.forRoot(...)` registers it.
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        OrderRepository,
        PlaceOrderHandler,
        GetOrderHandler,
        OrderCommittedProjection,
        OrderRollbackProjection,
      ],
    };
  }
}
