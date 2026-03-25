import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { UserEntity } from './user.entity';
import { UserService } from './user.service';

@Module({
  imports: [
    // `@nestjs/typeorm`'s standard wiring. `TypeOrmTransactionalModule`
    // resolves the actual DataSource through the same DI token, so the
    // standard NestJS pattern is the only one needed.
    TypeOrmModule.forRoot({
      type: 'sqljs',
      synchronize: true,
      entities: [UserEntity],
    }),
    TypeOrmModule.forFeature([UserEntity]),

    TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),

    // Phase 14.20: registers the TypeORM adapter for the default
    // dataSource. Importing this module is also what activates the
    // transparent-repository prototype patches at module-load time
    // (see `@nestjs-transactional/typeorm` JSDoc).
    TypeOrmTransactionalModule.forRoot(),
  ],
  providers: [UserService],
})
export class AppModule {}
