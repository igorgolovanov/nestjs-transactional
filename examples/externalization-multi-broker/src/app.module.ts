import { type DynamicModule, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ClientProxyTransport, OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { getDataSourceToken, TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import {
  externalizedRoute,
  toKafkaPacket,
  TransactionalOutboxModule,
} from '@nestjs-transactional/outbox';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import type { DataSource } from 'typeorm';

import { KAFKA_CLIENT, RABBITMQ_CLIENT, REDIS_CLIENT } from './clients.js';
import { OrderEntity } from './order.entity.js';
import { OrderService } from './order.service.js';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export interface BrokerConfig {
  readonly kafkaBrokers: readonly string[];
  readonly rabbitmqUrl: string;
  readonly redisHost: string;
  readonly redisPort: number;
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

export function readBrokerConfigFromEnv(): BrokerConfig {
  return {
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    rabbitmqUrl: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
    redisHost: process.env.REDIS_HOST ?? 'localhost',
    redisPort: Number(process.env.REDIS_PORT ?? 6379),
  };
}

@Module({})
export class AppModule {
  static forInfrastructure(
    postgres: PostgresConfig,
    brokers: BrokerConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    // One entry per broker. Each `name` is also the transport name in
    // `OutboxModule` below and the `client` an event names in
    // `@Externalized`, so one string ties the three together.
    const clients = ClientsModule.register([
      {
        name: KAFKA_CLIENT,
        transport: Transport.KAFKA,
        options: {
          client: {
            clientId: 'externalization-multi-broker-example',
            brokers: [...brokers.kafkaBrokers],
          },
        },
      },
      {
        name: RABBITMQ_CLIENT,
        transport: Transport.RMQ,
        options: {
          urls: [brokers.rabbitmqUrl],
          queue: 'refunds',
          queueOptions: { durable: true },
        },
      },
      {
        name: REDIS_CLIENT,
        transport: Transport.REDIS,
        options: { host: brokers.redisHost, port: brokers.redisPort },
      },
    ]);

    return {
      module: AppModule,
      imports: [
        clients,

        TypeOrmModule.forRoot({
          type: 'postgres',
          ...postgres,
          entities: [OrderEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),

        OutboxModule.forRoot({
          imports: [clients],
          transports: {
            // Kafka gets `toKafkaPacket`, so the routing key becomes the
            // partition key. RabbitMQ and Redis take the envelope as is.
            [KAFKA_CLIENT]: ClientProxyTransport(KAFKA_CLIENT, { toPacket: toKafkaPacket }),
            [RABBITMQ_CLIENT]: ClientProxyTransport(RABBITMQ_CLIENT),
            [REDIS_CLIENT]: ClientProxyTransport(REDIS_CLIENT),
          },
          // Every event here names its client, so routing is read off the
          // decorators. An event without one would fail its routing and
          // dead-letter rather than land on some broker by default.
          route: externalizedRoute(),
          relay: { enabled: options.relay ?? true, pollInterval: 100 },
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
        OrderService,
      ],
    };
  }
}
