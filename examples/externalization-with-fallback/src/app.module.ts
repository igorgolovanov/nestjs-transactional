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

import { REFUNDS_BROKER } from './clients';
import { ProcessedRefundEntity } from './processed-refunds.entity';
import { RefundConsumerService } from './refund-consumer.service';
import { RefundEntity } from './refund.entity';
import { RefundLedgerHandler } from './refund-ledger.handler';
import { RefundRequestedEvent } from './refund-requested.event';
import { RefundService } from './refund.service';

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
  static forInfrastructure(postgres: PostgresConfig, rabbitmq: RabbitMqConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ClientsModule.register([
          {
            name: REFUNDS_BROKER,
            transport: Transport.RMQ,
            options: {
              urls: [rabbitmq.url],
              queue: 'refunds',
              queueOptions: { durable: true },
            },
          },
        ]),

        TypeOrmModule.forRoot({
          type: 'postgres',
          ...postgres,
          entities: [
            RefundEntity,
            ProcessedRefundEntity,
            EventPublicationEntity,
            EventPublicationArchiveEntity,
          ],
          synchronize: true,
          logging: false,
        }),
        TypeOrmModule.forFeature([RefundEntity, ProcessedRefundEntity]),

        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TypeOrmTransactionalModule.forRoot(),
        OutboxTypeOrmModule.forRoot({ schemaInitialization: { enabled: false } }),

        OutboxModule.forRoot({
          repository: typeOrmEventPublicationRepositoryProvider(),
          // Slightly slower poll than the other examples — Failed
          // publication recovery in test 2 wants enough headroom
          // for the FAILED row to settle before resubmit.
          processor: { pollingInterval: 100, batchSize: 50 },
        }),
        OutboxModule.forFeature([RefundRequestedEvent]),

        OutboxMicroservicesModule.forRoot({ defaultClient: REFUNDS_BROKER }),

        OutboxProcessingModule,
      ],
      providers: [RefundService, RefundLedgerHandler, RefundConsumerService],
    };
  }
}
