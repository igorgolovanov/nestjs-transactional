# externalization-with-fallback

What a `COMPLETED` publication does and does not prove, and what to
build on the consumer side regardless. Single Postgres DataSource,
single RabbitMQ broker, single domain event (`RefundRequestedEvent`).

## What a successful publish means

A publication is marked `COMPLETED` when the externalizer resolves,
and what `emit()` waits for is transport-specific.

On the RabbitMQ used here it waits for a **publisher confirm**
(`amqp-connection-manager` enables confirms by default), so stopping
the broker makes `emit()` reject, the publication goes to `FAILED`
with a readable `failureReason`, and the retry and resubmit machinery
engages. Kafka behaves the same way, resolving `producer.send()` with
`kafkajs`' default `acks: -1`. Core NATS and TCP acknowledge nothing
at all, and gRPC cannot be used for externalization. The full table
is in
[ADR-021](../../docs/adr/021-externalization-acknowledgement-per-transport.md).

So the producer-side story is stronger than a naive reading of
"fire-and-forget" suggests, and it is still not the whole story: a
broker can acknowledge and then lose a message before durable
storage, and duplicates are expected by construction. That is what
the consumer-side pattern below is for.

> This example was originally built to demonstrate an ADR-016
> "silent success" limitation, on the premise that `emit()` could
> never report a broker failure. It was re-measured and it can.
> The example is reframed rather than deleted: the consumer-side
> inbox and the resubmit flow were always the valuable parts.

## What to actually configure

Do not give away what the defaults provide, before wiring the client
to `OutboxMicroservicesModule`:

- **RabbitMQ**: pass `persistent: true`. NestJS defaults it to
  `false`, and RabbitMQ confirms a non-persistent message without
  writing it to disk, so a broker restart loses it. Confirms
  themselves are already on; you do not need to add them.
- **Kafka** (kafkajs): the default `acks: -1` already waits for
  every in-sync replica. Add `producer: { idempotent: true }` to
  protect against duplicates from producer retries, and do not set
  `acks: 0`.
- **A different externalizer** where the transport cannot help. The
  `EVENT_EXTERNALIZER` SPI from DD-018 is public, so a
  JetStream-based NATS implementation slots into the same place.

This is configuration rather than a code pattern, so the example
does not demonstrate it at the code level. It is still the first
thing to get right.

## Consumer-side inbox / dedup table

Track every publication id the consumer has processed. Reject
duplicates. This makes consumer execution at-most-once even when
delivery is at-least-once or unreliable.

- [`src/processed-refunds.entity.ts`](src/processed-refunds.entity.ts)
  — the inbox table.
- [`src/refund-consumer.service.ts`](src/refund-consumer.service.ts)
  — the `process(event, publicationId)` method that SELECTs the
  inbox first, dedupes, and INSERTs as part of the processing
  transaction.

This is the **complementary pattern to the outbox**:
- Producer's outbox (this framework) → at-least-once *delivery
  attempts*.
- Consumer's inbox (this example's pattern) → at-most-once
  *processed effects*.

Together: exactly-once *effects*, even with at-least-once delivery
and an unreliable broker.

The integration test pins this end-to-end: invoke the consumer
twice with the same publication id — first call processes, second
call is a no-op.

## `FailedEventPublications.resubmit` for surfaced failures

When the externalizer DOES detect a failure (proxy threw, broker
explicitly rejected the message, network partition the proxy
surfaced as an error), the publication transitions to `FAILED`
with `failureReason` recorded. Operators can:

```ts
const failed = app.get(FailedEventPublications);
const count = await failed.count();              // how many?
const failures = await failed.findAll();          // inspect details
const resubmitted = await failed.resubmit();      // FAILED → RESUBMITTED
                                                  // processor picks up next poll
```

This is the Spring Modulith equivalent. The integration test pins
the round trip: emit throws → publication FAILED → operator calls
`resubmit()` → next poll succeeds → publication COMPLETED.

The outbox's `StartupRecoveryService` calls
`incomplete.resubmitIncompletePublications` at boot for crashed
in-flight rows; `FailedEventPublications` is the operator-driven
equivalent for explicit failures.

## When to use this example

- You're evaluating the framework for production and want to know
  what the failure modes look like.
- You're building a consumer service and need a reference for
  the inbox / dedup pattern.
- You're operating a deployment and want to validate the recovery
  flow before relying on it.

For the basic externalization shape see
[`externalization-kafka`](../externalization-kafka). This example
deliberately does not demonstrate multi-broker or multi-DS — those
axes are orthogonal to the reliability story.

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** Both the
  integration test (Postgres via testcontainers) and the visual
  demo (Postgres + RabbitMQ via `docker-compose`) need a Docker
  daemon.

## Run

```bash
pnpm install                                                  # from monorepo root

# Integration tests (Docker required for Postgres testcontainers):
pnpm -C examples/externalization-with-fallback test:integration

# Unit tests (none right now; passWithNoTests for symmetry):
pnpm -C examples/externalization-with-fallback test

# Visual demo against real Postgres + real RabbitMQ:
docker-compose -f examples/externalization-with-fallback/docker-compose.yml up -d
pnpm -C examples/externalization-with-fallback start
# When prompted: `docker-compose stop rabbitmq` (in a second terminal)
# Press ENTER to continue. Repeat for the restart step.
docker-compose -f examples/externalization-with-fallback/docker-compose.yml down -v
```

The visual demo deliberately requires manual broker operations
(stop / start) at two points. Watching the publication go to
`FAILED` with a real reason and then recover on `resubmit()` is the
point; automating the broker stop would hide it.

## What the integration test pins

1. **The completion contract** (1 test). Mocked `emit()` resolves
   `of(undefined)`; the publication transitions to COMPLETED. The
   externalizer treats a completion as success and does not
   second-guess it, which is the correct behaviour and is all it can
   do. What a completion proves about the broker is the transport's
   business, measured per transport in
   [ADR-021](../../docs/adr/021-externalization-acknowledgement-per-transport.md)
   and pinned against live brokers in the `outbox-microservices`
   package.

2. **Failed.resubmit recovery** (2 tests).
   - Single failed publication round trip: emit throws → row FAILED
     → `resubmit()` → next poll → COMPLETED.
   - Batch resubmit: three publications all fail under a sustained
     emit-throws regime; flipping the broker back and calling
     `resubmit()` once transitions all three.

3. **Consumer-side dedup template** (2 tests).
   - First invocation processes; second invocation with the same
     publication id is a no-op. The dedup table holds exactly one
     row.
   - Different publication ids of the same event class process
     independently — dedup is keyed on publication id, not event
     content.

## Key files

- [`src/refund-requested.event.ts`](src/refund-requested.event.ts)
  — the domain event with `@Externalized({ target: 'refunds',
  client: REFUNDS_BROKER })`. JSDoc enumerates what can happen to a
  publication.
- [`src/refund.service.ts`](src/refund.service.ts) — producer.
  Single-unit atomicity (DD-019); the method returns once the row is
  committed, long before the broker is involved.
- [`src/refund-ledger.handler.ts`](src/refund-ledger.handler.ts) —
  local listener that always fires once per publication regardless
  of broker outcome. Useful for in-process bookkeeping.
- [`src/processed-refunds.entity.ts`](src/processed-refunds.entity.ts)
  — the inbox / dedup table.
- [`src/refund-consumer.service.ts`](src/refund-consumer.service.ts)
  — consumer-side template. SELECT-then-INSERT inside a single
  transaction, with the table's PRIMARY KEY as the racy correctness
  gate.
- [`src/main.ts`](src/main.ts) — four-step visual demo with manual
  broker operations.
- [`docker-compose.yml`](docker-compose.yml) — Postgres + RabbitMQ
  stack. RabbitMQ management UI is exposed on port 15672 for
  verifying queue contents during the demo.
- [`test/with-fallback.integration.spec.ts`](test/with-fallback.integration.spec.ts)
  — testcontainers Postgres + mocked ClientProxy, five tests across
  three describe blocks.

## Common pitfalls

- **How much `event_publication.status === COMPLETED` proves depends
  on your transport.** On the RabbitMQ here it means a publisher
  confirm arrived; on core NATS it means nothing at all. Check the
  table at the top before relying on it.
- **The dedup table needs cleanup in production.** A real deployment
  TTLs old rows (e.g. archive after 30 days). The example doesn't
  bother — the table just grows.
- **`resubmit()` works for FAILED rows only.** Stuck PROCESSING
  rows are handled by `StalenessMonitor` + `IncompleteEventPublications`
  separately. See `outbox` README for the staleness story.
- **The producer's `@Transactional()` returns before the broker is
  ever contacted.** Delivery happens later, on the processor's poll.
  Don't infer anything about delivery from the publishing
  transaction committing.
- **`OutboxEventPublisher` injected by class token, NOT
  `@InjectOutboxPublisher`** (smart facade — DD-024). Same rule as
  every other Tier 3 example.

## Related examples

- [`externalization-kafka`](../externalization-kafka) — single-DS,
  single-broker baseline (Kafka instead of RabbitMQ; same shape).
- [`externalization-multi-broker`](../externalization-multi-broker)
  — three brokers, per-event `@Externalized({ client })` routing.
- [`externalization-multi-datasource`](../externalization-multi-datasource)
  — multi-DS + multi-broker combined.

## Further reading

- [ADR-021 — what `emit()` acknowledges, per transport](../../docs/adr/021-externalization-acknowledgement-per-transport.md)
  (the measurements, and the supersession of the silent-success
  finding this example was built around).
- [ADR-015 — event externalization architecture](../../docs/adr/015-event-externalization-architecture.md)
- [`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md)
- [`packages/outbox-microservices/README.md`](../../packages/outbox-microservices/README.md)
  — the per-transport table, package level.
- [Spring Modulith — externalization patterns](https://docs.spring.io/spring-modulith/reference/events.html#externalization)
