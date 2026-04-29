import { type DynamicModule, Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
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
        // Phase 14.20: one `forRoot` per dataSource. The first
        // becomes the default adapter; the second registers under
        // its named identifier.
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),
        TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),
      ],
      providers: [
        // Phase 14.20: the typeorm forRoot factory resolves each
        // DataSource via `getDataSourceToken(name)` — wire both
        // names. In a real app `TypeOrmModule.forRoot({ name })`
        // registers these globally; for the example we declare them
        // inline.
        { provide: getDataSourceToken(), useValue: primary },
        { provide: getDataSourceToken('billing'), useValue: billing },
        // Custom string tokens used by the example services for
        // direct injection.
        { provide: PRIMARY_DS, useValue: primary },
        { provide: BILLING_DS, useValue: billing },
        OrderService,
        BillingService,
      ],
    };
  }
}
