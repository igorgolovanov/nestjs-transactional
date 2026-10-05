# externalization-kafka

Events to **Apache Kafka** through the outbox: single Postgres
DataSource, single Kafka broker. The canonical externalization baseline.

A successful `@Transactional` method commits the order and its outbox
message in one transaction. After the commit,
[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox)'s relay
emits the message to Kafka through `ClientProxyTransport`. If Kafka
rejects it, the message stays in the outbox and is retried; a rollback
leaves no message, so nothing reaches Kafka for an order that does not
exist.

## When to use this example

- You have one DataSource, one broker, and want to see the simplest
  outbox-to-Kafka wiring.
- You want a regression template with a recorded `ClientProxy` (fast
  jest tests) plus a real Kafka stack via `docker-compose` (visual
  demo).
- You want Kafka keys and headers that come from the event.

For per-event routing to several brokers see
[`externalization-multi-broker`](../externalization-multi-broker). For
what happens when the broker stays down, dead letters included, see
[`externalization-with-fallback`](../externalization-with-fallback).

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** Both the
  integration test (Postgres via testcontainers) and the visual demo
  (Postgres + Kafka via `docker-compose`) need a Docker daemon.
- **For the visual demo**: `docker-compose up -d` to bring up
  Postgres and Kafka in KRaft mode (no Zookeeper).

## Run

```bash
pnpm install                                            # from monorepo root

# Integration tests (Docker required for Postgres testcontainers):
pnpm -C examples/externalization-kafka test:integration

# Visual demo against real Postgres + real Kafka:
docker-compose -f examples/externalization-kafka/docker-compose.yml up -d
pnpm -C examples/externalization-kafka start
```

## Architectural shape

```
OrderService.placeOrder  (@Transactional)
  ├─ INSERT orders
  └─ OutboxEventPublisher.publish(OrderPlacedEvent)
       └─ outbox.add(<the transaction @Transactional opened>, message)
                                         │  commit: both rows, or neither
                                         ▼
                         nest_outbox.messages
                                         │  @nestjs/outbox relay
                                         ▼
       route: externalizedRoute({ defaultTransport: KAFKA_CLIENT })
                                         │
                                         ▼
       ClientProxyTransport(KAFKA_CLIENT, { toPacket: toKafkaPacket })
                                         │
                                         ▼
       Kafka topic `orders.placed`
         key      = order id                      (routingKey)
         headers  = x-customer, x-event-type, x-outbox-id
         value    = { id, topic, key, headers, createdAt, payload }
```

## What it shows

1. **Atomicity across a broker.** The message commits with the order or
   rolls back with it. The relay only ever sees committed messages.
2. **The routing key is the Kafka key.** `@Externalized({ routingKey })`
   becomes the message key, and `toKafkaPacket` puts it on the Kafka
   record, so one order's events land on one partition, in commit order.
3. **Headers are Kafka headers**: the decorator's, plus `x-event-type`
   and `x-outbox-id`.
4. **The value is the envelope.** A consumer gets the event as
   `payload`, and a stable `id` to deduplicate on.
5. **A rejected emit is not lost.** The message stays in the outbox with
   the reason in `last_error`, and is retried with backoff.

## Why the integration test records `ClientProxy`

The test overrides `KAFKA_CLIENT` with an object whose `emit` records its
arguments. That keeps the suite at a few seconds and makes the Kafka
record itself the thing under test. What a real Kafka acknowledgement
means for an outbox message is measured once, against a testcontainers
broker, in the outbox package's broker suite (ADR-021).

The test also turns the relay off and calls `OutboxRelay.runOnce()`, so
delivery happens exactly when the test asks for it.

## Key files

- [`src/order-placed.event.ts`](src/order-placed.event.ts) —
  `@Externalized({ target, routingKey, headers })`.
- [`src/app.module.ts`](src/app.module.ts) — `ClientsModule.register`
  imported both by the app and by `OutboxModule`, the Kafka transport
  with `toKafkaPacket`, `externalizedRoute`, the store, and
  `TransactionalOutboxModule`.
- [`src/order.service.ts`](src/order.service.ts) — the
  `@Transactional()` method.
- [`test/order.service.integration.spec.ts`](test/order.service.integration.spec.ts)
  — commit, rollback, and a rejected emit.

## Common pitfalls

- **Import `ClientsModule` into `OutboxModule` too.** The transport
  resolves the client by its token in `OutboxModule`'s own context, so
  pass the registered module in `OutboxModule.forRoot({ imports })`.
- **Without `toKafkaPacket`, the Kafka key is empty.** The envelope still
  carries the key, but Kafka partitions by its own record key.
- **Keep `acks` at its default.** kafkajs's `acks: -1` waits for every
  in-sync replica; `acks: 0` would make "delivered" mean nothing.
  Consider `producer: { idempotent: true }` against duplicates from
  producer retries.
- **Version the payload.** A message added by the previous release can
  still be delivered after a deploy.

## Related examples

- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — the outbox without
  a broker.
- [`externalization-multi-broker`](../externalization-multi-broker) —
  three brokers, routed per event.
- [`externalization-with-fallback`](../externalization-with-fallback) —
  retries, dead letters, requeue, and the consumer's inbox.
- [`e-commerce-orders`](../e-commerce-orders) — Kafka at the end of a
  saga.

## Further reading

- [ADR-021 — what each transport acknowledges](../../docs/adr/021-externalization-acknowledgement-per-transport.md)
- [ADR-023 — delivery through `@nestjs/outbox`](../../docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
- [DD-028 — the bridge contract](../../docs/dd/028-outbox-bridge-contract.md)
