# @nestjs-transactional/outbox-microservices

> Spring Modulith `@Externalized` parity for NestJS — durable,
> retryable delivery of outbox events to external message brokers via
> the `@nestjs/microservices` `ClientProxy` abstraction.

`MicroservicesEventExternalizer` plugs into `@nestjs-transactional/outbox-core`
as the concrete `EventExternalizer` implementation and reuses the
existing `ClientsModule` registration in your application — one
package covers every transport `@nestjs/microservices` already
supports (Kafka, RabbitMQ, NATS, JMS, gRPC, custom).

## Status

**Alpha / Phase 11.3 of the monorepo roadmap.** The public API is not
yet stable and will change between 0.x releases. Headers / routingKey
are accepted on `@Externalized` but not yet applied to the wire
payload — see *Limitations* below.

## Installation

```bash
pnpm add @nestjs-transactional/outbox-microservices @nestjs-transactional/outbox-core @nestjs/microservices
```

`@nestjs-transactional/core`, `@nestjs/common`, `@nestjs/core`,
`reflect-metadata`, and `rxjs` are peer dependencies (already present
in any NestJS application).

## Prerequisites

This package does NOT register `ClientProxy` instances — that is your
job (DD-017). Configure them through the standard
`@nestjs/microservices` `ClientsModule`:

```typescript
import { ClientsModule, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: {
          client: { brokers: ['localhost:9092'] },
        },
      },
    ]),
  ],
})
export class AppModule {}
```

`OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA_CLIENT' })`
then resolves the same proxy via `ModuleRef.get(token, { strict: false })`
when an outbox publication is ready to be externalized — no parallel
connection pool, no second mental model.

## Basic example

```typescript
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TransactionalModule } from '@nestjs-transactional/core';
import { Externalized, OutboxModule } from '@nestjs-transactional/outbox-core';
import { OutboxMicroservicesModule } from '@nestjs-transactional/outbox-microservices';

@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  routingKey: (e) => e.tenantId, // see Limitations — logged, not yet applied
})
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly tenantId: string,
  ) {}
}

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: { client: { brokers: ['localhost:9092'] } },
      },
    ]),
    OutboxModule.forRoot({
      eventTypes: [OrderPlacedEvent],
    }),
    OutboxMicroservicesModule.forRoot({
      defaultClient: 'KAFKA_CLIENT',
    }),
  ],
})
export class AppModule {}
```

When an `OrderPlacedEvent` flows through the outbox the local
listeners run first; once they succeed the externalizer calls
`KAFKA_CLIENT.emit('orders.placed', event)`. Failures (broker down,
client misconfigured, ...) mark the publication `FAILED` and surface
through `FailedEventPublications.resubmit()` — single-unit atomicity
per [DD-019](../../CLAUDE.md).

## Multiple clients

Register every transport you need under distinct tokens, then point
each event at its broker via the `client` option on `@Externalized`:

```typescript
ClientsModule.register([
  { name: 'KAFKA_CLIENT', transport: Transport.KAFKA, options: { ... } },
  { name: 'AMQP_CLIENT',  transport: Transport.RMQ,   options: { ... } },
]),

@Externalized({ target: 'orders.placed', client: 'KAFKA_CLIENT' })
class OrderPlacedEvent { /* ... */ }

@Externalized({ target: 'audit', client: 'AMQP_CLIENT' })
class AuditableEvent { /* ... */ }
```

A `defaultClient` configured on the module is used when an event
omits the per-event `client`. Set neither and the externalizer
rejects the publication with a clear `ExternalizationError` — the row
is recorded as `FAILED` and the operator can fix the configuration
and resubmit.

## Async configuration

For `defaultClient` that must be resolved from a `ConfigService`:

```typescript
OutboxMicroservicesModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    defaultClient: config.getOrThrow<string>('outbox.defaultClient'),
  }),
}),
```

## Bootstrap validation

By default the module resolves `defaultClient` once at
`OnApplicationBootstrap` and throws a descriptive error if the token
is unbound — the misconfiguration surfaces before the first event is
processed. Disable with `validateOnBootstrap: false` when the
`ClientProxy` registration is wired by an asynchronous factory that
finishes after the outbox bootstrap (the lookup is then deferred to
the first `externalize()` call).

## Limitations (Phase 11.3)

- **Headers and `routingKey` are accepted but not applied** to the
  wire payload yet. The `@nestjs/microservices` `ClientProxy.emit`
  API has no unified headers / routing-key parameter — handling is
  transport-specific (Kafka headers, AMQP properties, NATS subject
  suffixes, ...). For now the externalizer logs resolved values at
  debug level for visibility; the broker-aware message-construction
  iteration ships in a later release. Wrap the event in a
  transport-specific envelope inside your own code if you need them
  before then.
- **Real-broker integration tests** (Postgres + Kafka / RabbitMQ via
  testcontainers) ship with Phase 11.4 — the unit and module specs in
  this package use a mock `ClientProxy` and cover the SPI contract
  end-to-end without a live broker.

## Testing

The package's own tests use a mock `ClientProxy` directly. To exercise
the externalizer in your application's tests, register a stub provider
under your client's token before the module imports:

```typescript
const moduleRef = await Test.createTestingModule({
  imports: [
    /* ... ClientsModule.register([{ name: 'KAFKA_CLIENT', ... }]) */
    OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA_CLIENT' }),
  ],
})
  .overrideProvider('KAFKA_CLIENT')
  .useValue({ emit: jest.fn(() => of(undefined)) })
  .compile();
```

## License

MIT — see [LICENSE](../../LICENSE).
