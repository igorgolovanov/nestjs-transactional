import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { WalletRow } from './wallet.entity.js';
import { WalletProjection } from './wallet.listener.js';
import { WALLET_REPOSITORY, TypeOrmWalletRepository } from './wallet.repository.js';
import { WalletService } from './wallet.service.js';

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
  /**
   * `relay: false` leaves the outbox's relay stopped, so a test can
   * deliver with `OutboxRelay.runOnce()` exactly when it wants to.
   */
  static forConfig(
    config: PostgresConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    return {
      module: WalletModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          entities: [WalletRow],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([WalletRow]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRoot({ isDefault: true }),

        OutboxModule.forRoot({ relay: { enabled: options.relay ?? true, pollInterval: 100 } }),
        TransactionalOutboxModule.forRoot(),
      ],
      providers: [
        {
          provide: PostgresOutboxStore,
          inject: [getDataSourceToken(), OutboxStorage],
          useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
        },
        WalletService,
        WalletProjection,
        { provide: WALLET_REPOSITORY, useClass: TypeOrmWalletRepository },
      ],
      exports: [WalletService, WalletProjection],
    };
  }
}
