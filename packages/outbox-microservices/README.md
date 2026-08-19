# @nestjs-transactional/outbox-microservices

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox-microservices?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox-microservices)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

Forwards outbox events to a message broker through
`@nestjs/microservices`.

Mark an event `@Externalized`, and once its local handlers have
completed, [`@nestjs-transactional/outbox`](https://www.npmjs.com/package/@nestjs-transactional/outbox)
hands it to this package, which emits it over a `ClientProxy` you
already configured. One implementation covers every transport
`@nestjs/microservices` supports — Kafka, RabbitMQ, NATS, MQTT, Redis,
gRPC, and custom strategies.

> ## Read this before production
>
> `ClientProxy.emit()` cannot tell you whether the broker accepted the
> message. Its Observable completes when the transport has *accepted the
> handoff*, not when the broker has *durably acknowledged* — so a
> `ClientKafka` pointed at an unreachable broker resolves successfully,
> this package reports success, and the publication is finalised as
> `COMPLETED` even though nothing was ever delivered.
>
> Because the layer believes delivery succeeded, the outbox's retry,
> staleness and resubmit machinery never engages: there is no `FAILED`
> row to act on.
>
> What the outbox still guarantees is crash-consistent **enqueueing**
> and at-least-once delivery to **local** handlers. What it does not yet
> guarantee, through `ClientProxy`, is at-least-once delivery to the
> **broker**. Full analysis and the path forward:
> [ADR-016](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/016-externalization-reliability-semantics.md).

## Install

```bash
pnpm add @nestjs-transactional/outbox-microservices @nestjs-transactional/outbox @nestjs/microservices
```

## Quick start

This package does not create broker connections — you register clients
the standard way, and it reuses them.

```ts
import { ClientsModule, Transport } from '@nestjs/microservices';
import { Externalized, OutboxModule } from '@nestjs-transactional/outbox';
import { OutboxMicroservicesModule } from '@nestjs-transactional/outbox-microservices';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: { client: { brokers: ['localhost:9092'] } },
      },
    ]),

    // ...the usual outbox wiring...

    OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA_CLIENT' }),
  ],
})
export class AppModule {}
```

```ts
@Externalized({ target: 'orders.placed' })
export class OrderPlacedEvent {
  constructor(public readonly orderId: string) {}
}
```

That is the whole integration: events without `@Externalized` stay
local, and events with it are emitted after their local handlers
finish. The proxy is resolved at publication time through `ModuleRef`,
so there is no second connection pool and no parallel configuration to
keep in sync
([DD-017](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/017-reuse-clients-module.md)).

## Routing to several brokers

Name a client per event; `defaultClient` covers the rest.

```ts
@Externalized({ target: 'orders.placed', client: 'KAFKA_CLIENT' })
export class OrderPlacedEvent {}

@Externalized({ target: 'billing.invoice', client: 'RABBIT_CLIENT' })
export class InvoiceIssuedEvent {}
```

An unresolvable client name fails at bootstrap rather than at the first
publication, so a typo surfaces on deploy instead of in the middle of
the night. Pass `validateOnBootstrap: false` to defer resolution if you
register clients late.

## Reducing the risk

Given the reliability gap above, three things help — in order of how
much they buy you:

1. **Configure the proxy for stronger acknowledgement.** Kafka:
   `producer.acks: 'all'` with `producer.idempotent: true`. RabbitMQ: a
   confirm channel via `amqp-connection-manager`. NATS: JetStream with
   explicit ack. This package reuses whatever you registered and does
   not interfere.
2. **Deduplicate on the consumer.** Track processed message ids on the
   receiving side and alert on gaps. The listener id plus the event id
   is enough to identify a message.
3. **Wait for broker-aware externalizers** if neither is workable. The
   `EVENT_EXTERNALIZER` SPI is stable, and native producer-based
   implementations will slot into the same place without changes on your
   side.

## Limitations

- **Headers and `routingKey`** are accepted by `@Externalized` but not
  yet applied to the emitted payload.
- **Delivery is fire-and-forget** by design — see the note at the top.

## Documentation

- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)
- [Reliability semantics (ADR-016)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/016-externalization-reliability-semantics.md)
- [Externalization architecture (ADR-015)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/015-event-externalization-architecture.md)
- [Architecture: event externalization](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/architecture/event-externalization.md)
- Runnable examples:
  [`externalization-kafka`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/externalization-kafka),
  [`externalization-multi-broker`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/externalization-multi-broker),
  [`externalization-with-fallback`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/externalization-with-fallback)

## License

MIT
