import { type DynamicModule, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ClientProxyTransport, OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { externalizedRoute, TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { REFUNDS_BROKER } from './clients.js';
import { RefundConsumerService } from './refund-consumer.service.js';
import { RefundEntity } from './refund.entity.js';
import { RefundService } from './refund.service.js';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export interface RabbitMqConfig {
  readonly url: string;
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

export function readRabbitMqConfigFromEnv(): RabbitMqConfig {
  return { url: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672' };
}

@Module({})
export class AppModule {
  static forInfrastructure(
    postgres: PostgresConfig,
    rabbitmq: RabbitMqConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    const clients = ClientsModule.register([
      {
        name: REFUNDS_BROKER,
        transport: Transport.RMQ,
        options: {
          urls: [rabbitmq.url],
          queue: 'refunds',
          queueOptions: { durable: true },
          // NestJS defaults this to `false`, and RabbitMQ confirms a
          // non-persistent message without writing it to disk, so a
          // broker restart would lose a message the outbox already
          // counted as published. Publisher confirms are on by default.
          persistent: true,
        },
      },
    ]);

    return {
      module: AppModule,
      imports: [
        clients,

        TypeOrmModule.forRoot({
          type: 'postgres',
          ...postgres,
          entities: [RefundEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([RefundEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),

        OutboxModule.forRoot({
          imports: [clients],
          transports: { [REFUNDS_BROKER]: ClientProxyTransport(REFUNDS_BROKER) },
          route: externalizedRoute(),
          relay: { enabled: options.relay ?? true, pollInterval: 100 },
          // Three attempts, a second apart at first. A real deployment
          // sizes this to how long the broker may be down: the default,
          // 20 attempts, spans 30 to 60 minutes. Once the attempts run
          // out the message is dead-lettered with its error history, and
          // an operator requeues it (`OutboxDeadLetters.requeue`).
          retry: { attempts: 3, backoff: { delay: '1s', maxDelay: '10s' } },
        }),
        TransactionalOutboxModule.forRoot(),
      ],
      providers: [
        {
          provide: PostgresOutboxStore,
          inject: [getDataSourceToken(), OutboxStorage],
          useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
        },
        RefundService,
        RefundConsumerService,
      ],
    };
  }
}
