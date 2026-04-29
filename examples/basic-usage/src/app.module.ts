import { type DynamicModule, Module } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
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
        TypeOrmTransactionalModule.forRoot(),
      ],
      providers: [
        // Phase 14.20: `TypeOrmTransactionalModule.forRoot` resolves
        // the DataSource via `@nestjs/typeorm`'s `getDataSourceToken`.
        // In a real app `TypeOrmModule.forRoot(...)` registers this;
        // for the example we wire it manually under both the standard
        // `getDataSourceToken()` and the `DataSource` class token (the
        // latter for direct `@InjectDataSource()` usage).
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: DataSource, useValue: dataSource },
        UserService,
      ],
    };
  }
}
