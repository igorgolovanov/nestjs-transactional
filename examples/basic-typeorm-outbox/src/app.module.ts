import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { OrderEntity } from './order.entity.js';
import { OrderService } from './order.service.js';
import { ShippingHandler } from './shipping.handler.js';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export function readPostgresConfigFromEnv(): PostgresConfig {
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'postgres',
  };
}

@Module({})
export class AppModule {
  /**
   * Static factory so `main.ts` (env-driven) and the integration test
   * (testcontainers-driven) can pass their own Postgres configuration
   * without sharing global state. Tests pass `relay: false` and drive
   * delivery with `OutboxRelay.runOnce()`, so nothing races the
   * assertions.
   */
  static forPostgres(
    config: PostgresConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          entities: [OrderEntity],
          // Example-only; production runs migrations. The outbox's own
          // tables are created by its store, in the `nest_outbox` schema.
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRoot(),

        // `@nestjs/outbox`, configured as its documentation shows. With
        // no transports every message goes to its `local` transport,
        // which runs the `@OnOutboxMessage` handlers in this process.
        OutboxModule.forRoot({
          // Faster than the 1s default, so the demo and tests observe
          // delivery quickly.
          relay: { enabled: options.relay ?? true, pollInterval: 100 },
        }),
        // The bridge: `OutboxEventPublisher` adds messages inside the
        // transaction `@Transactional` opened.
        TransactionalOutboxModule.forRoot(),
      ],
      providers: [
        // The outbox's store, on the same database as the orders, so a
        // message commits with the order that produced it.
        {
          provide: PostgresOutboxStore,
          inject: [getDataSourceToken(), OutboxStorage],
          useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
        },
        OrderService,
        ShippingHandler,
      ],
    };
  }
}
