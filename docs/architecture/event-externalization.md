# Event externalization

Externalization sends an event out of the application, to a broker,
through the outbox. From 3.0.0 the delivery is
[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox)'s: its
relay hands the message to a `ClientProxyTransport`, which calls
`ClientProxy.emit()` on a client from `@nestjs/microservices`. This
repository contributes the declaration (`@Externalized`) and the routing
and packet helpers (ADR-023, DD-028).

The 2.x design, with its own `EventExternalizer` SPI and
`outbox-microservices` package, is recorded in ADR-015 and DD-016.

## Shape

```
@Externalized({ target, client?, routingKey?, headers? })   on the event class
        │
        ▼  OutboxEventPublisher.publish(event), inside @Transactional
outbox message { topic: target, key: routingKey(event), headers, payload }
        │  commits with the business write
        ▼
@nestjs/outbox relay
        │  route: externalizedRoute()  →  the transport named by `client`
        ▼
ClientProxyTransport(client, { toPacket? })
        │  client.emit(topic, envelope | Kafka record)
        ▼
broker
```

## The pieces

- **`@Externalized`** marks an event class. `target` is the topic.
  `client` names an `OutboxModule` transport, conventionally the
  `ClientsModule` token it wraps; `'local'` is the in-process transport.
  `routingKey` becomes the message key, which orders delivery per key
  and, for Kafka, becomes the partition key. `headers` become message
  headers. The decorator records `target → client` when the class is
  evaluated, and a target declared with two clients fails there.
- **`externalizedRoute({ defaultTransport, fallback })`** builds
  `OutboxModule`'s `route` from those records. A target without a client
  goes to `defaultTransport`; with no default, routing fails and the
  message dead-letters rather than being sent somewhere by guess.
  Everything that is not an externalized target goes to `fallback`,
  `'local'` by default.
- **`toKafkaPacket`** is a `toPacket` for `ClientProxyTransport` over
  Kafka. It puts the message key on the Kafka key, the headers on Kafka
  headers plus `x-outbox-id`, and the envelope in the value.

## What reaches the broker

`@nestjs/outbox`'s envelope:

```ts
interface OutboxEnvelope<P> {
  id: string; // stable across redeliveries: the consumer's dedup key
  topic: string;
  key: string | null;
  headers: Record<string, string>;
  createdAt: number;
  payload: P; // the event, as JSON
}
```

With `toKafkaPacket` the Kafka value is that envelope, and the key and
headers are on the Kafka record as well.

## What a delivery proves

The relay removes a message once `emit()` resolves, and what `emit()`
waits for depends on the transport. Measured in
[ADR-021](../adr/021-externalization-acknowledgement-per-transport.md),
and confirmed independently by `@nestjs/outbox`'s documentation:

| Transport | `emit()` resolves when | Broker acknowledgement |
| --- | --- | --- |
| Kafka | `producer.send()` settles, with kafkajs's default `acks = -1` | Yes |
| RabbitMQ | the publisher confirm arrives (`confirm` defaults to `true`) | Yes; set `persistent: true` so the broker writes it to disk |
| MQTT | PUBACK at QoS 1 and above, immediately at QoS 0 | Depends on QoS |
| Redis | the `PUBLISH` command replies | Received, not persisted; only live subscribers get it |
| TCP | the bytes are written to the socket | No |
| NATS (core) | immediately | No |
| gRPC | never: `dispatchEvent` throws | Cannot be used |

A rejected `emit()` keeps the message in the outbox: it is retried with
backoff and dead-lettered after the last attempt. The broker suite in
`packages/outbox/test/brokers` pins that against real Kafka and
RabbitMQ, so the claim cannot quietly go stale again.

## Delivery guarantee

At least once, end to end: the message commits with the business write,
and is emitted until a transport acknowledges it or it is dead-lettered.
Duplicates are expected, after a relay crash between the emit and the
bookkeeping, or after a requeue. Consumers deduplicate on `envelope.id`,
for instance with `@nestjs/outbox`'s inbox.

## One message, one transport

An outbox message goes to exactly one transport. An event that must
reach a broker and an in-process handler is published under two topics,
or handled on the broker's consumer side. This is a change from 2.x,
where an externalized event also ran its local listeners.

## Limitations

- The outbox lives in one DataSource, so every externalized event is
  published from a transaction on that DataSource.
- `@nestjs/outbox` is pre-1.0; the bridge pins `~0.1.0`.

## References

- [ADR-021 — what each transport acknowledges](../adr/021-externalization-acknowledgement-per-transport.md)
- [ADR-023 — delivery through `@nestjs/outbox`](../adr/023-delegate-delivery-to-nestjs-outbox.md)
- [DD-028 — the bridge contract](../dd/028-outbox-bridge-contract.md)
- Examples: [`externalization-kafka`](../../examples/externalization-kafka),
  [`externalization-multi-broker`](../../examples/externalization-multi-broker),
  [`externalization-with-fallback`](../../examples/externalization-with-fallback)
