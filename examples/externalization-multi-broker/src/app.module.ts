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

import { AccountingHandler } from './accounting.handler';
import { CacheInvalidationEvent } from './cache-invalidation.event';
import { KAFKA_CLIENT, RABBITMQ_CLIENT, REDIS_CLIENT } from './clients';
import { LocalCacheInvalidator } from './local-cache.handler';
import { OrderEntity } from './order.entity';
import { OrderPlacedEvent } from './order-placed.event';
import { OrderService } from './order.service';
import { RefundRequestedEvent } from './refund-requested.event';
import { ShippingHandler } from './shipping.handler';

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
  static forInfrastructure(postgres: PostgresConfig, brokers: BrokerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Per DD-017 the user registers ALL clients themselves —
        // the framework module does NOT register clients. Three
        // entries here, one per broker. Each `name` matches the
        // string token consumed by `@Externalized({ client })` on
        // the corresponding event class.
        ClientsModule.register([
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
        ]),

        TypeOrmModule.forRoot({
          type: 'postgres',
          ...postgres,
          entities: [OrderEntity, EventPublicationEntity, EventPublicationArchiveEntity],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([OrderEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),
        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),

        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forFeature([OrderPlacedEvent, RefundRequestedEvent, CacheInvalidationEvent]),

        // `defaultClient` is required for bootstrap validation
        // (`@Optional()` resolution path through DI) — every event
        // in this example declares its own `client:` override on
        // `@Externalized`, so the default never fires at runtime.
        // We point it at Kafka because Kafka is the heaviest broker
        // here; if a user accidentally publishes an event WITHOUT
        // the decorator, the resulting "stuck on default" failure
        // mode is loudest there.
        OutboxMicroservicesModule.forRoot({ defaultClient: KAFKA_CLIENT }),

        OutboxProcessingModule,
      ],
      providers: [
        OrderService,
        ShippingHandler,
        AccountingHandler,
        LocalCacheInvalidator,
      ],
    };
  }
}
