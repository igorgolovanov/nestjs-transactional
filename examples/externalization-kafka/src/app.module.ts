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

import { OrderEntity } from './order.entity.js';
import { OrderService } from './order.service.js';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

export interface KafkaConfig {
  readonly brokers: readonly string[];
  readonly clientId: string;
}

export const KAFKA_CLIENT = 'KAFKA_CLIENT';

export function readPostgresConfigFromEnv(): PostgresConfig {
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    username: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    database: process.env.PGDATABASE ?? 'postgres',
  };
}

export function readKafkaConfigFromEnv(): KafkaConfig {
  return {
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    clientId: process.env.KAFKA_CLIENT_ID ?? 'externalization-kafka-example',
  };
}

@Module({})
export class AppModule {
  /**
   * Compose the example with caller-supplied infrastructure. `main.ts`
   * reads from env vars (visual demo against real Postgres + Kafka via
   * `docker-compose up`); the integration test passes testcontainers
   * coordinates for Postgres, overrides `KAFKA_CLIENT` with a recording
   * `ClientProxy`, and turns the relay off to drive it by hand.
   */
  static forInfrastructure(
    postgres: PostgresConfig,
    kafka: KafkaConfig,
    options: { readonly relay?: boolean } = {},
  ): DynamicModule {
    // Registered once and imported twice: by this module, and by
    // `OutboxModule`, whose transport resolves the client by its token.
    const clients = ClientsModule.register([
      {
        name: KAFKA_CLIENT,
        transport: Transport.KAFKA,
        options: {
          client: { clientId: kafka.clientId, brokers: [...kafka.brokers] },
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
          entities: [OrderEntity],
          // Example-only; production wires migrations.
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),

        OutboxModule.forRoot({
          imports: [clients],
          // `toKafkaPacket` turns the message key into the Kafka key and
          // the headers into Kafka headers. Without it the envelope still
          // arrives, but with an empty Kafka key.
          transports: {
            [KAFKA_CLIENT]: ClientProxyTransport(KAFKA_CLIENT, { toPacket: toKafkaPacket }),
          },
          // `OrderPlacedEvent` names no client, so it goes to the default.
          route: externalizedRoute({ defaultTransport: KAFKA_CLIENT }),
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
