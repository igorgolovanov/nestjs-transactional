# @nestjs-transactional/outbox-microservices

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox-microservices?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox-microservices)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

Forwards outbox events to a message broker through
`@nestjs/microservices`.

Mark an event `@Externalized`, and once its local handlers have
completed, [`@nestjs-transactional/outbox`](https://www.npmjs.com/package/@nestjs-transactional/outbox)
hands it to this package, which emits it over a `ClientProxy` you
already configured. One implementation covers every transport
`@nestjs/microservices` supports — Kafka, RabbitMQ, MQTT, Redis, NATS,
and custom strategies. gRPC is the exception; see below.

## What a successful publish means on your transport

A publication is marked `COMPLETED` when `emit()` resolves, and what
`emit()` waits for is not the same on every transport. Kafka and
RabbitMQ wait for a real broker acknowledgement, so an unreachable
broker marks the publication `FAILED` and the outbox's retry and
resubmit machinery engages. NATS and TCP do not wait for anything.

| Transport | `emit()` resolves when | Acknowledged by the broker? |
| --- | --- | --- |
| Kafka | `producer.send()` settles; `kafkajs` defaults to `acks: -1`, every in-sync replica | Yes |
| RabbitMQ | the publisher confirm arrives (`amqp-connection-manager` enables confirms by default) | Yes, but set `persistent: true` |
| MQTT | PUBACK at QoS 1 and above, immediately at QoS 0 | At QoS 1 and above |
| Redis | the `PUBLISH` command replies | The server got it, but Redis pub/sub does not persist: only live subscribers receive it |
| TCP | the message is written to the socket | No |
| NATS | immediately: core `publish()` returns `void`, and the client resolves unconditionally | No |
| gRPC | never: `dispatchEvent` throws `Method is not supported in gRPC mode` | Not usable for externalization |

Two things worth acting on:

- **RabbitMQ publishes non-persistent by default.** NestJS defaults
  `persistent` to `false`, and RabbitMQ confirms a non-persistent
  message without writing it to disk, so a broker restart loses it.
  Pass `persistent: true` in your `ClientsModule.register()` options.
- **NATS gives you no delivery signal at all.** Core NATS publish is
  fire-and-forget by protocol. If you need a guarantee there, this
  externalizer is not the right one; the `EVENT_EXTERNALIZER` SPI is
  public and a JetStream-based implementation slots into the same
  place.

The outbox itself guarantees crash-consistent **enqueueing** and
at-least-once delivery to **local** handlers regardless of transport.
Measurements, the reading of each client's `dispatchEvent`, and what
remains genuinely unguaranteed:
[ADR-021](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/021-externalization-acknowledgement-per-transport.md).

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

## Hardening the delivery

The defaults are reasonable on Kafka and RabbitMQ. What is left is
mostly about not weakening them, and about the consumer side.

1. **Do not configure the acknowledgement away.** Kafka `acks: 0`,
   MQTT QoS 0, and RabbitMQ without `persistent: true` each give up a
   guarantee you had for free. `producer.idempotent: true` on Kafka
   additionally protects against duplicates from producer retries.
   This package reuses whatever proxy you registered and does not
   interfere with any of it.
2. **Deduplicate on the consumer.** At-least-once means duplicates are
   expected, not exceptional. Track processed message ids on the
   receiving side and alert on gaps. The listener id plus the event id
   is enough to identify a message.
3. **Watch the `FAILED` publications.** A broker rejection now reaches
   you as a `FAILED` row with a readable `failureReason`, which is what
   `FailedEventPublications.resubmit` and the retry scheduler act on.
   That path is only useful if someone is looking at it.

## Limitations

- **Headers and `routingKey`** are accepted by `@Externalized` but not
  yet applied to the emitted payload.
- **gRPC cannot be used** as an externalization transport:
  `ClientGrpcProxy.dispatchEvent` throws.
- **NATS and TCP give no delivery signal** — see the table at the top.

## Documentation

- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)
- [Acknowledgement per transport (ADR-021)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/021-externalization-acknowledgement-per-transport.md)
- [Externalization architecture (ADR-015)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/015-event-externalization-architecture.md)
- [Architecture: event externalization](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/architecture/event-externalization.md)
- Runnable examples:
  [`externalization-kafka`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/externalization-kafka),
  [`externalization-multi-broker`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/externalization-multi-broker),
  [`externalization-with-fallback`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/externalization-with-fallback)

## License

MIT
