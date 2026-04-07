# externalization-kafka

Outbox externalization to **Apache Kafka** via `@nestjs/microservices`
`ClientProxy` — single Postgres DataSource, single Kafka broker. The
canonical Phase 11 / Tier 3 baseline.

A successful `@Transactional` method commits the business INSERT and
the `event_publication` row in one transaction; the worker dispatches
to BOTH the local `@OutboxEventsHandler` AND to Kafka. Single-unit
atomicity (DD-019) is preserved end-to-end.

## When to use this example

- You have one DataSource, one broker, and want to see the simplest
  outbox-to-Kafka wiring.
- You want a regression template for externalization-publishing
  services with mocked `ClientProxy` (fast jest tests) plus a real
  Kafka stack via `docker-compose` (visual demo).
- You're evaluating Phase 11 externalization before adopting it.

For multi-broker per-event routing see
[`externalization-multi-broker`](../externalization-multi-broker).
For the ADR-016 reliability limitation in action see
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

# Unit tests (none right now; passWithNoTests for symmetry):
pnpm -C examples/externalization-kafka test

# Visual demo against real Postgres + real Kafka:
docker-compose -f examples/externalization-kafka/docker-compose.yml up -d
pnpm -C examples/externalization-kafka start
docker-compose -f examples/externalization-kafka/docker-compose.yml down -v
```

## Architectural shape

```
   @Transactional()
       |
       v
  +-----------------+        commit
  | OrderService    |  ----> [orders row]   (Postgres)
  | placeOrder()    |  ----> [event_publication row]   (Postgres)
  +-----------------+
                                  |
                                  v
                  +---------------------------+
                  | EventPublicationProcessor |  poll FOR UPDATE SKIP LOCKED
                  +-------------+-------------+
                                |
                  +-------------+-------------+
                  v                           v
          ShippingHandler           MicroservicesEventExternalizer
          (local listener)          (KAFKA_CLIENT.emit('orders.placed', event))
                                              |
                                              v
                                          [Kafka topic
                                           'orders.placed']
```

**Execution order (DD-019)**: local handlers run BEFORE
externalization. If `ShippingHandler.handle` throws, Kafka is NEVER
emitted and the publication stays `FAILED` for retry. If the local
handler succeeds and Kafka emit throws, the publication ALSO ends up
`FAILED` — single-unit atomicity covers both halves.

## Why the integration test mocks `ClientProxy`

`@nestjs/microservices` `ClientProxy.emit()` does NOT propagate
broker-side delivery failures (ADR-016). With an unreachable broker,
`emit()` resolves successfully and the outbox publication finalises
as `COMPLETED` regardless of whether the message landed. Real-broker
integration tests therefore can't reliably distinguish "Kafka
received the message" from "proxy queued it locally and dropped it"
— they only verify the happy path, which mocked tests verify with
deterministic timing and zero CI flakiness.

For end-to-end broker observation (and the documented limitation in
action: stop the broker, observe `COMPLETED`) see
[`externalization-with-fallback`](../externalization-with-fallback)
and run its `pnpm start` demo.

## What it shows

1. **Atomic commit + dual delivery.** `OrderService.placeOrder` runs
   `orders.save(...)` and `outbox.publish(...)` in one
   `@Transactional` method. After commit the worker invokes BOTH the
   local `ShippingHandler` AND the externalizer (Kafka emit). On
   success the publication transitions to `COMPLETED`.
2. **Atomic rollback.** `placeOrderAndFail` does the same writes and
   throws. Neither row is persisted, the local handler never runs,
   Kafka never emits.
3. **Externalizer failure surfacing.** When `KAFKA_CLIENT.emit` throws
   (proxy-level rejection — distinct from ADR-016 silent broker
   failure), the publication is marked `FAILED` with `failureReason`
   set. The local handler still ran (DD-019 ordering).
4. **Per-event Kafka routing key + headers.**
   `@Externalized<OrderPlacedEvent>({ routingKey: e => e.orderId,
   headers: e => ({ ... }) })` derives partition affinity (Kafka
   message key) and tracing headers from the event instance. Today
   `MicroservicesEventExternalizer` passes `(target, event)` to
   `client.emit` — `routingKey` and `headers` are stored in
   `ExternalizationMetadata` and available for transport-aware
   externalizers in future iterations.

## Key files

- [`src/order-placed.event.ts`](src/order-placed.event.ts) — the
  domain event with `@Externalized({ target: 'orders.placed',
  routingKey, headers })`.
- [`src/order.service.ts`](src/order.service.ts) — `@Transactional()`
  method that writes the entity AND publishes via the outbox.
  `OutboxEventPublisher` is injected by class token (smart facade,
  DD-024) — NOT via `@InjectOutboxPublisher`.
- [`src/shipping.handler.ts`](src/shipping.handler.ts) — local
  `@OutboxEventsHandler` with a stable id (`Shipping.createShipment`).
- [`src/app.module.ts`](src/app.module.ts) — wiring:
  `ClientsModule.register([{ name: KAFKA_CLIENT, transport:
  Transport.KAFKA, ... }])` (per DD-017 the user registers clients),
  then `OutboxMicroservicesModule.forRoot({ defaultClient:
  KAFKA_CLIENT })`.
- [`src/main.ts`](src/main.ts) — visual demo with a kafkajs consumer
  that prints messages off the topic so the externalization is
  visible in the terminal.
- [`docker-compose.yml`](docker-compose.yml) — Postgres + Kafka KRaft
  stack for the visual demo.
- [`test/order.service.integration.spec.ts`](test/order.service.integration.spec.ts)
  — testcontainers Postgres + mocked `KAFKA_CLIENT` ClientProxy.

## Common pitfalls

- **`OutboxEventPublisher` is injected by class token, NOT
  `@InjectOutboxPublisher`.** The decorator binds the per-DS
  underlying publisher, bypassing smart-facade routing (DD-024).
  Single-DS examples like this one don't notice the difference, but
  the class-token form is the canonical default — the decorator is
  for advanced multi-DS routing scenarios. See
  `multi-datasource-outbox` for the case where it matters.
- **`ClientsModule` registers the proxy; the framework module does
  NOT** (DD-017). `OutboxMicroservicesModule.forRoot({ defaultClient
  })` only wires the externalizer; the user owns the
  `ClientsModule.register([...])` call.
- **Production must NOT use `synchronize: true` for outbox tables.**
  This example uses it for one-shot demo simplicity; production
  runs the migration shipped with
  `@nestjs-transactional/outbox-typeorm`.
- **`@nestjs/microservices` Kafka silent-success limitation
  (ADR-016).** When the broker is unreachable, `emit()` resolves
  successfully. The outbox cannot detect this and marks the
  publication `COMPLETED`. See `externalization-with-fallback` for
  mitigation patterns (consumer-side idempotency, broker-aware
  externalizer iteration).
- **Listener id stability.** Default `${ClassName}#${EventName}`
  rolls when you rename the handler class. This example pins
  `id: 'Shipping.createShipment'` so a future rename does not
  invalidate stored publications.

## Related examples

- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — same
  Postgres + outbox shape WITHOUT externalization. The base case
  this example extends.
- [`externalization-multi-broker`](../externalization-multi-broker)
  — single DS, multiple brokers (Kafka + RabbitMQ + Redis), per-event
  `@Externalized({ client })` routing.
- [`externalization-multi-datasource`](../externalization-multi-datasource)
  — multi-DS + multi-broker, combined complexity.
- [`externalization-with-fallback`](../externalization-with-fallback)
  — ADR-016 limitation in action plus mitigation patterns
  (`FailedEventPublications.resubmit`, consumer-side idempotency).

## Further reading

- [ADR-015 — event externalization architecture](../../docs/adr/015-event-externalization-architecture.md)
- [ADR-016 — externalization reliability semantics](../../docs/adr/016-externalization-reliability-semantics.md)
- [`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md)
- [Spring Modulith — event externalization reference](https://docs.spring.io/spring-modulith/reference/events.html#externalization)
