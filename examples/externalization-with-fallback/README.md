# externalization-with-fallback

The honest example. Demonstrates the **ADR-016 silent-success
limitation** of `@nestjs/microservices` `ClientProxy.emit()` and the
production mitigation patterns. Single Postgres DataSource, single
RabbitMQ broker, single domain event (`RefundRequestedEvent`).

## The problem (ADR-016 in two sentences)

`@nestjs/microservices` `ClientProxy.emit()` does NOT propagate
broker-side delivery failures. With an unreachable broker, `emit()`
resolves successfully and the outbox publication finalises as
`COMPLETED` regardless of whether the message ever landed on the
queue.

The framework cannot detect this. The producer-side outbox
guarantees at-least-once *attempted publish*; the broker-side
delivery guarantee is whatever the configured `ClientProxy` knows
how to surface — and in the current `@nestjs/microservices` this is
"basically nothing." Production deployments need a complementary
strategy.

## The three mitigations (in order of preference)

### 1. Transport-level idempotent + confirm at the producer

Configure your `ClientProxy` for stronger acknowledgment BEFORE
wiring it to `OutboxMicroservicesModule`:

- **Kafka** (kafkajs): `producer: { acks: 'all', idempotent: true }`.
  With idempotency on, the producer waits for in-sync replica acks
  and surfaces broker-rejected messages as thrown errors that
  `MicroservicesEventExternalizer` will catch and turn into
  publication FAILED.
- **RabbitMQ** (`amqp-connection-manager` + `amqplib`): use
  publisher confirms (`channel.confirm`) on the underlying
  connection. The pattern is library-specific; the goal is the
  same — make the proxy `emit()` reject when delivery isn't
  acknowledged.
- **Native broker libraries**: roll your own externalizer (the
  `EVENT_EXTERNALIZER` SPI from DD-018) that bypasses
  `@nestjs/microservices` entirely and uses
  e.g. `kafkajs` directly. Future broker-aware externalizers are
  documented in CLAUDE.md "Future phases."

This example does NOT demonstrate (1) at the code level — it is a
configuration concern, not a code pattern. It IS what we recommend
production deployments adopt first.

### 2. Consumer-side inbox / dedup table

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

### 3. `FailedEventPublications.resubmit` for surfaced failures

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

`StartupRecoveryService` (Phase 5) calls
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
(stop / start) at two points. The whole point of the example is to
SEE the silent-success state — automating the broker stop would
hide it.

## What the integration test pins

1. **Silent-success contract** (1 test). Mocked `emit()` resolves
   `of(undefined)` always; publication transitions to COMPLETED;
   the externalizer cannot tell that "succeeded" doesn't imply
   "broker received." The mock and a real unreachable broker
   produce indistinguishable framework behavior.

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
  client: REFUNDS_BROKER })`. JSDoc enumerates the three fates
  (happy / silent fail / surfaced fail).
- [`src/refund.service.ts`](src/refund.service.ts) — producer.
  Single-unit atomicity (DD-019); after this method returns the
  producer never knows whether the broker actually received
  anything.
- [`src/refund-ledger.handler.ts`](src/refund-ledger.handler.ts) —
  local listener that always fires once per publication regardless
  of broker outcome. Useful for in-process bookkeeping.
- [`src/processed-refunds.entity.ts`](src/processed-refunds.entity.ts)
  — the inbox / dedup table.
- [`src/refund-consumer.service.ts`](src/refund-consumer.service.ts)
  — consumer-side template. SELECT-then-INSERT inside a single
  transaction, with the table's PRIMARY KEY as the racy correctness
  gate.
- [`src/main.ts`](src/main.ts) — three-step visual demo with manual
  broker operations.
- [`docker-compose.yml`](docker-compose.yml) — Postgres + RabbitMQ
  stack. RabbitMQ management UI is exposed on port 15672 for
  verifying queue contents during the demo.
- [`test/with-fallback.integration.spec.ts`](test/with-fallback.integration.spec.ts)
  — testcontainers Postgres + mocked ClientProxy, five tests across
  three describe blocks.

## Common pitfalls

- **Don't rely on `event_publication.status === COMPLETED` as proof
  the broker received the message.** That's the whole point of this
  example. Use one of the three mitigations above.
- **The dedup table needs cleanup in production.** A real deployment
  TTLs old rows (e.g. archive after 30 days). The example doesn't
  bother — the table just grows.
- **`resubmit()` works for FAILED rows only.** Stuck PROCESSING
  rows are handled by `StalenessMonitor` + `IncompleteEventPublications`
  separately. See `outbox` README for the staleness story.
- **The producer's `@Transactional()` returns successfully even
  when the eventual broker delivery fails silently.** Don't infer
  delivery success from the publishing transaction completing —
  there is no causal relationship.
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

- [ADR-016 — externalization reliability semantics](../../docs/adr/016-externalization-reliability-semantics.md)
  (the source of the silent-success finding and the three
  mitigation strategies).
- [ADR-015 — event externalization architecture](../../docs/adr/015-event-externalization-architecture.md)
- [`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md)
- [`packages/outbox-microservices/README.md`](../../packages/outbox-microservices/README.md)
  — package-level documentation of the limitation.
- [Spring Modulith — externalization patterns](https://docs.spring.io/spring-modulith/reference/events.html#externalization)
