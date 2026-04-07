import { type DynamicModule, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';
import { OutboxMicroservicesModule } from '@nestjs-transactional/outbox-microservices';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

import { OrderEntity } from './order.entity';
import { OrderPlacedEvent } from './order-placed.event';
import { OrderService } from './order.service';
import { ShippingHandler } from './shipping.handler';

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
   * coordinates for Postgres and a mocked `ClientProxy` provider that
   * shadows `KAFKA_CLIENT`.
   */
  static forInfrastructure(postgres: PostgresConfig, kafka: KafkaConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Per DD-017 the user registers `ClientsModule` themselves.
        // `OutboxMicroservicesModule.forRoot({ defaultClient })` does
        // NOT register clients — it only binds the externalizer.
        ClientsModule.register([
          {
            name: KAFKA_CLIENT,
            transport: Transport.KAFKA,
            options: {
              client: { clientId: kafka.clientId, brokers: [...kafka.brokers] },
            },
          },
        ]),

        TypeOrmModule.forRoot({
          type: 'postgres',
          ...postgres,
          entities: [OrderEntity, EventPublicationEntity, EventPublicationArchiveEntity],
          // Example-only — production wires migrations.
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),
        OutboxTypeOrmModule.forRoot({
          schemaInitialization: { enabled: false },
        }),

        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          // Faster polling so the demo and tests observe delivery
          // quickly. Production tunes by latency vs. DB load.
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forFeature([OrderPlacedEvent]),

        // The externalizer wiring — single line. Reuses the
        // `KAFKA_CLIENT` proxy registered above; no per-event
        // `client:` override needed when there's only one broker.
        OutboxMicroservicesModule.forRoot({ defaultClient: KAFKA_CLIENT }),

        OutboxProcessingModule,
      ],
      providers: [OrderService, ShippingHandler],
    };
  }
}
