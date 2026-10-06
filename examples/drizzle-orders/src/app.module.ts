import { type DynamicModule, Module } from '@nestjs/common';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { WorkflowsModule, WorkflowStorage } from '@nestjs/workflows';
import { fromDrizzle, PostgresWorkflowStore, type SqlExecutor } from '@nestjs/workflows/postgres';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalDrizzleModule } from '@nestjs-transactional/drizzle';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TransactionalWorkflowsModule } from '@nestjs-transactional/workflows';

import {
  type Database,
  DB,
  DatabaseModule,
  type PostgresConfig,
} from './database/database.module.js';
import { NotificationsHandler } from './notifications/notifications.handler.js';
import { OrdersService } from './orders/orders.service.js';
import { ShipOrder } from './shipping/ship-order.workflow.js';
import { ShippingService } from './shipping/shipping.service.js';

/**
 * The one way both stores reach PostgreSQL: `fromDrizzle` from
 * `@nestjs/store-kit`, re-exported by `@nestjs/outbox/postgres` and
 * `@nestjs/workflows/postgres` alike. It runs the stores' SQL on the
 * Drizzle `tx` it is handed; the bridges hand it the `tx` of the
 * transaction `@Transactional` opened.
 */
const SQL_EXECUTOR = Symbol('SQL_EXECUTOR');

@Module({})
export class AppModule {
  /**
   * The orders, the outbox (`nest_outbox`) and the workflows
   * (`nest_workflows`) on one PostgreSQL database, so one transaction can
   * write all three. Tests pass `relay: false` and drive the outbox with
   * `OutboxRelay.runOnce()`.
   */
  static forPostgres(
    config: PostgresConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.forPostgres(config),

        // @Transactional, on the Drizzle db registered under DB.
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalDrizzleModule.forRoot({ db: DB }),

        // @nestjs/outbox, and the bridge that adds messages inside the
        // transaction @Transactional opened.
        OutboxModule.forRoot({ relay: { enabled: options.relay ?? true, pollInterval: 100 } }),
        TransactionalOutboxModule.forRoot(),

        // @nestjs/workflows with its worker, and the bridge that makes
        // start() and signal() join the transaction.
        WorkflowsModule.forRoot({ worker: { pollInterval: '50ms' } }),
        TransactionalWorkflowsModule.forRoot(),
      ],
      providers: [
        {
          provide: SQL_EXECUTOR,
          inject: [DB],
          useFactory: (db: Database): SqlExecutor => fromDrizzle(db),
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
        OrdersService,
        ShippingService,
        ShipOrder,
        NotificationsHandler,
      ],
    };
  }
}
