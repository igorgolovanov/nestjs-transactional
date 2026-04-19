import { type DynamicModule, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { WalletOperationEvent } from './events';
import { WalletProjection } from './wallet.listener';
import { WALLET_REPOSITORY, TypeOrmWalletRepository } from './wallet.repository';
import { WalletRow } from './wallet.entity';
import { WalletService } from './wallet.service';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/**
 * Production module. Used as-is by the **integration** test tier
 * (testcontainers Postgres). The unit and outbox-unit tiers build
 * their own slim modules that swap pieces out — see the test files.
 */
@Module({})
export class WalletModule {
  static forConfig(config: PostgresConfig): DynamicModule {
    return {
      module: WalletModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          entities: [WalletRow, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([WalletRow]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot({ isDefault: true }),

        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),
        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forFeature([WalletOperationEvent]),
        OutboxProcessingModule,

        CqrsTransactionalModule.forRoot(),
      ],
      providers: [
        WalletService,
        WalletProjection,
        { provide: WALLET_REPOSITORY, useClass: TypeOrmWalletRepository },
      ],
      exports: [WalletService, WalletProjection],
    };
  }
}
