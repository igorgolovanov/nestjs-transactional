import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { CompensationHandler } from './compensation.handler.js';
import { OrderRow, PaymentRow, ReservationRow, StockItemRow } from './entities.js';
import { OrderService } from './order.service.js';
import { PaymentHandler } from './payment.handler.js';
import { ReservationHandler } from './reservation.handler.js';
import { ShipmentHandler } from './shipment.handler.js';

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
    database: process.env.PGDATABASE ?? 'saga',
  };
}

/**
 * Single-DataSource saga example. Every step (reservation, payment,
 * shipment, compensation) runs against the same Postgres DB through
 * the same outbox. The lesson is the choreography pattern itself —
 * the framework's multi-DS facilities (DD-021/023, ADR-018) are
 * deliberately NOT exercised here so that the saga shape is the
 * only complexity in the room. Tier 5's `e-commerce-orders` covers
 * a saga split across DataSources.
 *
 * Every step is an `@OnOutboxMessage` handler of `@nestjs/outbox`,
 * subscribed to the topic the bridge gives an event without
 * `@Externalized`: its class name. Each runs in its own
 * `@Transactional()`, and the events it publishes there commit with its
 * own writes, so the next step only ever sees an outcome that happened.
 */
@Module({})
export class AppModule {
  /** `relay: false` lets tests drive the saga step by step with `runOnce()`. */
  static forConfig(
    config: PostgresConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          ...config,
          entities: [OrderRow, ReservationRow, PaymentRow, StockItemRow],
          synchronize: true, // example-only — production runs migrations
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderRow, ReservationRow, PaymentRow, StockItemRow]),

        // ----- Process-wide transactional infrastructure -----
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRoot({ isDefault: true }),

        // ----- Outbox -----
        // Aggressive polling so the visual demo finishes in a couple of
        // seconds. Production tunes this per workload, and may run the
        // relay in its own deployment.
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
        OrderService,
        ReservationHandler,
        PaymentHandler,
        ShipmentHandler,
        CompensationHandler,
      ],
    };
  }
}
