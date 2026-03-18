import { type DynamicModule, Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { BILLING_DS, BillingService } from './billing.service';
import { InvoiceEntity, OrderEntity } from './entities';
import { OrderService, PRIMARY_DS } from './order.service';

export async function createDataSources(): Promise<{
  primary: DataSource;
  billing: DataSource;
}> {
  const primary = new DataSource({
    type: 'sqljs',
    synchronize: true,
    entities: [OrderEntity],
  });
  const billing = new DataSource({
    type: 'sqljs',
    synchronize: true,
    entities: [InvoiceEntity],
  });
  await primary.initialize();
  await billing.initialize();
  return { primary, billing };
}

@Module({})
export class AppModule {
  static forDataSources(primary: DataSource, billing: DataSource): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        // The first forFeature becomes the default adapter (instance name 'default').
        TypeOrmTransactionalModule.forFeature({ dataSource: primary }),
        TypeOrmTransactionalModule.forFeature({
          dataSourceName: 'billing',
          dataSource: billing,
        }),
      ],
      providers: [
        { provide: PRIMARY_DS, useValue: primary },
        { provide: BILLING_DS, useValue: billing },
        OrderService,
        BillingService,
      ],
    };
  }
}
