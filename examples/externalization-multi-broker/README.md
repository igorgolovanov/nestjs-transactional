# externalization-multi-broker

Outbox externalization to **three different brokers** in one process,
routed per event by `@Externalized({ client })`. Single Postgres
DataSource, three `ClientProxy` registrations, three event classes, each
landing on the broker that fits its semantics.

| Event | Broker | Why |
|---|---|---|
| `OrderPlacedEvent` | **Kafka** topic `orders.placed` | Partitioned ordering on the consumer side, high throughput. `routingKey: e => e.orderId` becomes the Kafka message key, so every event for one order lands on one partition. |
| `RefundRequestedEvent` | **RabbitMQ** queue `refunds` | Work-queue semantics: each refund is a unit of work, processed once with consumer acks. |
| `CacheInvalidationEvent` | **Redis pub/sub** channel `cache.invalidated` | Ephemeral fan-out: every running instance subscribes and drops the affected key. No durability or ack needed. |

The headline: one string ties each event to its broker. It is the
`client` on `@Externalized`, the transport name in `@nestjs/outbox`'s
`OutboxModule`, and the `ClientsModule` token, and `externalizedRoute()`
reads the routing off the decorators.

## When to use this example

- You have one DataSource but several brokers (typical for
  service-oriented and modular monoliths).
- You want to see how event-shape semantics map to broker choice.
- You need a regression template for cross-broker isolation: one broker
  failing must not hold back messages to the others.

For a single-broker baseline see
[`externalization-kafka`](../externalization-kafka).

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** Both the
  integration test (Postgres via testcontainers) and the visual demo
  (Postgres + Kafka + RabbitMQ + Redis via `docker-compose`) need a
  Docker daemon.

## Run

```bash
pnpm install                                                  # from monorepo root

# Integration tests (Docker required for Postgres testcontainers):
pnpm -C examples/externalization-multi-broker test:integration

# Visual demo against real Postgres + Kafka + RabbitMQ + Redis:
docker-compose -f examples/externalization-multi-broker/docker-compose.yml up -d
pnpm -C examples/externalization-multi-broker start
```

## Wiring

```ts
OutboxModule.forRoot({
  imports: [clients],
  transports: {
    KAFKA_CLIENT: ClientProxyTransport(KAFKA_CLIENT, { toPacket: toKafkaPacket }),
    RABBITMQ_CLIENT: ClientProxyTransport(RABBITMQ_CLIENT),
    REDIS_CLIENT: ClientProxyTransport(REDIS_CLIENT),
  },
  route: externalizedRoute(),
});
```

Kafka gets `toKafkaPacket` so the routing key becomes the partition key.
RabbitMQ and Redis receive `@nestjs/outbox`'s envelope as is, which
already carries the message `id`, `key` and `headers`.

Every event here names its client, so `externalizedRoute()` needs no
default. An event that named none would fail its routing and
dead-letter, rather than land on some broker by guess.

## What it shows

1. **Per-event routing.** Each event reaches its own broker and no other.
2. **One transaction, three brokers.** The order and all three messages
   commit together; a rollback leaves nothing for any broker.
3. **Failure isolation.** With Kafka rejecting, the Kafka message stays
   in the outbox for a retry while RabbitMQ and Redis still get theirs.
   One message per destination is what makes that possible: each is
   retried on its own.

## Key files

- [`src/clients.ts`](src/clients.ts) — the three client tokens.
- [`src/order-placed.event.ts`](src/order-placed.event.ts),
  [`src/refund-requested.event.ts`](src/refund-requested.event.ts),
  [`src/cache-invalidation.event.ts`](src/cache-invalidation.event.ts) —
  `@Externalized({ target, client, ... })`.
- [`src/app.module.ts`](src/app.module.ts) — three registrations, three
  transports, `externalizedRoute()`.
- [`test/multi-broker.integration.spec.ts`](test/multi-broker.integration.spec.ts)
  — routing per event, atomicity, delivery to all three, and isolation
  when Kafka fails.

## Common pitfalls

- **Name the client on every event**, or give `externalizedRoute` a
  `defaultTransport`. Without either, the message dead-letters.
- **One target, one client.** Two event classes declaring the same
  `target` with different clients fail at decoration time.
- **Redis pub/sub is fire-and-forget.** A subscriber that is not
  connected when the message arrives never sees it; that is the trade
  for an ephemeral channel, not something the outbox can fix (ADR-021).

## Related examples

- [`externalization-kafka`](../externalization-kafka) — one broker, with
  the Kafka record in detail.
- [`externalization-with-fallback`](../externalization-with-fallback) —
  what happens when a broker stays down.

## Further reading

- [ADR-021 — what each transport acknowledges](../../docs/adr/021-externalization-acknowledgement-per-transport.md)
- [DD-028 — the bridge contract](../../docs/dd/028-outbox-bridge-contract.md)
