import { type DynamicModule, Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { UserEntity } from './user.entity';
import { UserService } from './user.service';

export async function createDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'sqljs',
    synchronize: true,
    entities: [UserEntity],
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
      ],
      providers: [{ provide: DataSource, useValue: dataSource }, UserService],
    };
  }
}
