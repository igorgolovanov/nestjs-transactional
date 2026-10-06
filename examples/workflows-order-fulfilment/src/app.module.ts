import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { WorkflowsModule, WorkflowStorage } from '@nestjs/workflows';
import { WorkflowsCqrsModule } from '@nestjs/workflows/cqrs';
import { fromTypeOrm, PostgresWorkflowStore, type SqlExecutor } from '@nestjs/workflows/postgres';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalCqrsModule } from '@nestjs-transactional/cqrs';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TransactionalTypeOrmModule } from '@nestjs-transactional/typeorm';
import { TransactionalWorkflowsModule } from '@nestjs-transactional/workflows';
import type { DataSource } from 'typeorm';

import { AnalyticsProjection } from './analytics/analytics.projection.js';
import { InventoryService } from './fakes/inventory.service.js';
import { PaymentsService } from './fakes/payments.service.js';
import { FulfilOrder } from './fulfilment/fulfil-order.workflow.js';
import { OrderEntity } from './orders/order.entity.js';
import { OrdersService } from './orders/orders.service.js';
import { PlaceOrderHandler } from './orders/place-order.handler.js';

/**
 * The one way both stores reach PostgreSQL. `fromTypeOrm` comes from
 * `@nestjs/store-kit`, which `@nestjs/outbox/postgres` and
 * `@nestjs/workflows/postgres` both re-export: the same function, so one
 * executor serves both stores. It runs the stores' SQL on whatever
 * TypeORM transaction it is handed, and the bridges hand it the
 * `EntityManager` of the transaction `@Transactional` opened.
 */
const SQL_EXECUTOR = Symbol('SQL_EXECUTOR');

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
   * Everything on one PostgreSQL database: the orders, the outbox
   * (`nest_outbox` schema) and the workflows (`nest_workflows` schema),
   * so one transaction can write all three. Tests pass `relay: false`
   * and drive the outbox with `OutboxRelay.runOnce()`.
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
          // Example-only; production runs migrations. The outbox and the
          // workflow store create their own schemas.
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderEntity]),

        // @Transactional, on TypeORM.
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRoot(),

        // @nestjs/cqrs, through the transactional module, which imports
        // CqrsModule.forRoot() itself. Do not import CqrsModule again.
        TransactionalCqrsModule.forRoot(),

        // @nestjs/outbox, and the bridge that adds messages inside the
        // transaction @Transactional opened.
        OutboxModule.forRoot({ relay: { enabled: options.relay ?? true, pollInterval: 100 } }),
        TransactionalOutboxModule.forRoot(),

        // @nestjs/workflows with its worker, the CQRS integration behind
        // @StartOn, and the bridge that makes start() and signal() join
        // the transaction.
        WorkflowsModule.forRoot({ worker: { pollInterval: '50ms' } }),
        WorkflowsCqrsModule,
        TransactionalWorkflowsModule.forRoot(),
      ],
      providers: [
        {
          provide: SQL_EXECUTOR,
          inject: [getDataSourceToken()],
          useFactory: (dataSource: DataSource): SqlExecutor => fromTypeOrm(dataSource),
        },
        {
          provide: PostgresOutboxStore,
          inject: [SQL_EXECUTOR, OutboxStorage],
          useFactory: (executor: SqlExecutor, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor }, storage),
        },
        {
          provide: PostgresWorkflowStore,
          inject: [SQL_EXECUTOR, WorkflowStorage],
          useFactory: (executor: SqlExecutor, storage: WorkflowStorage) =>
            new PostgresWorkflowStore({ executor }, storage),
        },
        PlaceOrderHandler,
        OrdersService,
        FulfilOrder,
        PaymentsService,
        InventoryService,
        AnalyticsProjection,
      ],
    };
  }
}
