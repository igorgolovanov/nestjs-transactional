# externalization-multi-broker

Outbox externalization to **three different brokers** in a single
process, routed per-event via `@Externalized({ client })`. Single
Postgres DataSource, three `ClientProxy` registrations, three event
classes — each landing on the broker that fits its semantics.

| Event | Broker | Why |
|---|---|---|
| `OrderPlacedEvent` | **Kafka** topic `orders.placed` | Partitioned ordering on the consumer side, high throughput. `routingKey: e => e.orderId` derives the Kafka message key so all events for the same order go to the same partition. |
| `RefundRequestedEvent` | **RabbitMQ** queue `refunds` | Work-queue semantics — each refund is a unit of work that should be processed exactly once with consumer acks. |
| `CacheInvalidationEvent` | **Redis pub/sub** channel `cache.invalidated` | Ephemeral fan-out — every running instance subscribes and drops the affected key. No durability or ack needed. |

The headline: per-event `@Externalized({ client: 'KAFKA_CLIENT' | 'RABBITMQ_CLIENT' | 'REDIS_CLIENT' })` tells `MicroservicesEventExternalizer` which `ClientProxy` to use. Multi-broker routing is decorator-driven, not configuration-driven.

## When to use this example

- You have one DataSource but multiple brokers (typical for service-
  oriented monoliths and modular monoliths).
- You want to see how event-shape semantics map to broker choice.
- You need a regression template for cross-broker isolation:
  one broker failing should not block publications going to other
  brokers.

For a single-broker baseline see
[`externalization-kafka`](../externalization-kafka). For multi-DS +
multi-broker combined complexity see
[`externalization-multi-datasource`](../externalization-multi-datasource).

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

# Unit tests (none right now; passWithNoTests for symmetry):
pnpm -C examples/externalization-multi-broker test

# Visual demo against real Postgres + real Kafka + RabbitMQ + Redis:
docker-compose -f examples/externalization-multi-broker/docker-compose.yml up -d
pnpm -C examples/externalization-multi-broker start
docker-compose -f examples/externalization-multi-broker/docker-compose.yml down -v
```

## Architectural shape

```
                 +-------------------+
                 |   OrderService    |
                 |  @Transactional() |
                 +---------+---------+
                           |
            outbox.publish(OrderPlacedEvent)
            outbox.publish(RefundRequestedEvent)   (when refundCents)
            outbox.publish(CacheInvalidationEvent)
                           |
                           v
              +------------------------+
              |   event_publication    |  (3 rows in 1 tx commit)
              +-----------+------------+
                          |
              EventPublicationProcessor
                          |
        +-----------------+--------------------+
        |                 |                    |
  ShippingHandler    AccountingHandler   LocalCacheInvalidator
   (local)            (local)             (local)
        |                 |                    |
        v                 v                    v
  KAFKA_CLIENT.emit   RABBITMQ_CLIENT.emit  REDIS_CLIENT.emit
   ('orders.placed',   ('refunds',           ('cache.invalidated',
    OrderPlacedEvent)   RefundRequestedEvent) CacheInvalidationEvent)
        |                 |                    |
        v                 v                    v
  +-----------+      +-----------+         +---------+
  |   Kafka   |      | RabbitMQ  |         |  Redis  |
  +-----------+      +-----------+         +---------+
```

`MicroservicesEventExternalizer.externalize(event, metadata)` reads
`metadata.client` (set by the `@Externalized({ client })` decorator
on the event class) and resolves the corresponding `ClientProxy` via
`ModuleRef`. No central routing table — the routing decision lives
on the event class itself.

## Why `defaultClient` is set even though every event has its own

`OutboxMicroservicesModule.forRoot({ defaultClient })` validates at
bootstrap that the configured default is a resolvable token —
`validateOnBootstrap: true` is the default. We point it at
`KAFKA_CLIENT` here. At runtime the default never fires because
every `@Externalized` decorator overrides it. The setting exists as
a safety net: if a future event class is decorated with
`@Externalized` WITHOUT a `client` field, it will use the default
rather than fail with "no client resolvable for event X". Pointing
the default at the heaviest broker (Kafka) makes that failure mode
loudest if it ever happens.

## Per-event vs per-DataSource routing

Phase 14.6 (Q1.A) explicitly chose **per-event** routing over
**per-DataSource** routing. There is ONE
`MicroservicesEventExternalizer` instance for every dataSource —
the `@nestjs-transactional/outbox-microservices` module is `@Global`.
`@Externalized({ client })` is the routing axis. This composes with
the multi-`OutboxModule.forRoot()` shape (ADR-019); see
[`externalization-multi-datasource`](../externalization-multi-datasource)
for that combination.

## What it shows

1. **Per-event broker routing.** Each event class declares the broker
   it belongs to via `@Externalized({ client })`. Tests verify each
   event routes to ONLY the correct proxy — the other two never see
   it.
2. **Local handler symmetry.** Each event has a local
   `@OutboxEventsHandler` running BEFORE the externalizer (DD-019
   ordering). The pattern is uniform — Kafka, RabbitMQ, Redis don't
   change the local-handler-first contract.
3. **Single-transaction multi-broker fan-out.** One `@Transactional`
   method publishes three events of three different shapes; all
   three commit together as part of the same `event_publication`
   batch; the worker dispatches them independently to three brokers.
4. **Atomic rollback across brokers.** When the `@Transactional`
   method throws, NONE of the three brokers receives anything —
   the atomicity gate covers the whole fan-out.
5. **Per-publication isolation.** When ONE broker fails (e.g. Kafka
   `emit` throws), only that publication's row ends up `FAILED`.
   The other two publications complete independently — single-unit
   atomicity is per publication row (DD-019), not across the fan-out.

## Key files

- [`src/clients.ts`](src/clients.ts) — central DI tokens (KAFKA_CLIENT
  / RABBITMQ_CLIENT / REDIS_CLIENT) so `@Externalized({ client })`
  on events, `ClientsModule.register([...])` in AppModule, and the
  test's `overrideProvider(...).useValue(...)` all reference the
  same strings.
- [`src/order-placed.event.ts`](src/order-placed.event.ts) —
  `@Externalized({ client: KAFKA_CLIENT, target: 'orders.placed' })`
  with a `routingKey` callback for partition affinity.
- [`src/refund-requested.event.ts`](src/refund-requested.event.ts) —
  `@Externalized({ client: RABBITMQ_CLIENT, target: 'refunds' })`.
- [`src/cache-invalidation.event.ts`](src/cache-invalidation.event.ts)
  — `@Externalized({ client: REDIS_CLIENT, target: 'cache.invalidated' })`.
- [`src/order.service.ts`](src/order.service.ts) — single
  `@Transactional` method publishing all three events.
- Three local handlers — [`shipping.handler.ts`](src/shipping.handler.ts),
  [`accounting.handler.ts`](src/accounting.handler.ts),
  [`local-cache.handler.ts`](src/local-cache.handler.ts).
- [`src/app.module.ts`](src/app.module.ts) — composition root with
  three `ClientsModule.register([...])` entries.
- [`test/multi-broker.integration.spec.ts`](test/multi-broker.integration.spec.ts)
  — Postgres real, three mocked `ClientProxy`s, six tests pinning
  routing + atomicity + per-publication isolation.
- [`docker-compose.yml`](docker-compose.yml) — Postgres + Kafka KRaft +
  RabbitMQ + Redis stack for the visual demo.

## Common pitfalls

- **One `MicroservicesEventExternalizer` per process, NOT per
  broker.** The framework module registers ONE externalizer; routing
  to specific brokers happens via `metadata.client` on each event.
  Don't try to register multiple externalizers — that would
  duplicate the SPI binding.
- **`defaultClient` is mandatory for bootstrap validation.** Either
  give every event class an explicit `client` (this example does)
  AND keep `defaultClient` pointing at one of the registered
  proxies as a safety net, or expect bootstrap to fail with "no
  defaultClient configured".
- **`OutboxEventPublisher` injected by class token, NOT
  `@InjectOutboxPublisher`** (smart facade — DD-024). Same rule as
  `externalization-kafka`.
- **Each event is its own publication row.** If a service publishes
  three events in one transaction, the outbox commits three rows.
  Per-row failure isolation means a Kafka outage doesn't block
  RabbitMQ + Redis delivery for events published in the same
  transaction.
- **Cross-broker delivery is NOT distributed-transactional.** Local
  handlers + externalization for any single event are atomic
  (DD-019); the three events' publications are independent. If you
  need "all three brokers received OR none did", you need
  application-level coordination (e.g. one umbrella event
  externalized to a single broker, with downstream fan-out).

## Related examples

- [`externalization-kafka`](../externalization-kafka) — single-DS,
  single-broker. The base case this example extends.
- [`externalization-multi-datasource`](../externalization-multi-datasource)
  — multi-DS + multi-broker, real production scenario.
- [`externalization-with-fallback`](../externalization-with-fallback)
  — ADR-016 limitation in action plus mitigation patterns.

## Further reading

- [ADR-015 — event externalization architecture](../../docs/adr/015-event-externalization-architecture.md)
- [ADR-016 — externalization reliability semantics](../../docs/adr/016-externalization-reliability-semantics.md)
- [`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md)
- [`packages/outbox-microservices/README.md`](../../packages/outbox-microservices/README.md)
  — the multi-broker section that this example expands on.
