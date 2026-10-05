# externalization-with-fallback

What a delivered message does and does not prove, what happens when the
broker is down, and what to build on the consumer side regardless.
Single Postgres DataSource, single RabbitMQ broker, single domain event
(`RefundRequestedEvent`).

## What a delivery means

[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox)'s relay
removes a message from the outbox when the transport's `emit()`
resolves, and what `emit()` waits for is transport-specific.

On the RabbitMQ used here it waits for a **publisher confirm**
(`amqp-connection-manager` enables confirms by default), so a broker that
is down makes `emit()` reject and the message stays in the outbox. Kafka
behaves the same way, resolving `producer.send()` with kafkajs's default
`acks: -1`. Core NATS, Redis and TCP acknowledge less or nothing at all,
and gRPC cannot be used. The full table is in
[ADR-021](../../docs/adr/021-externalization-acknowledgement-per-transport.md),
and `@nestjs/outbox`'s own documentation reached the same conclusion
independently.

So the producer side is stronger than "fire-and-forget" suggests, and
still not the whole story: a broker can acknowledge and then lose a
message before durable storage, and delivery is at-least-once, so
duplicates are expected by construction. That is what the consumer-side
inbox below is for.

## What to actually configure

- **RabbitMQ**: pass `persistent: true`, as this example does. NestJS
  defaults it to `false`, and RabbitMQ confirms a non-persistent message
  without writing it to disk, so a broker restart loses a message the
  outbox already counted as delivered. Confirms themselves are on by
  default.
- **Kafka** (kafkajs): the default `acks: -1` already waits for every
  in-sync replica. Add `producer: { idempotent: true }` against
  duplicates from producer retries, and do not set `acks: 0`.
- **Retries**: size `retry` in `OutboxModule` to how long the broker may
  be down. This example allows three attempts so the demo and tests
  reach a dead letter quickly; `@nestjs/outbox`'s default, 20 attempts,
  spans 30 to 60 minutes.

## The fallback path

1. **The broker rejects.** The message stays in `nest_outbox.messages`
   with the reason in `last_error` and is scheduled for a retry with
   backoff.
2. **The broker recovers before the attempts run out.** The next retry
   delivers it, and it leaves the outbox.
3. **The attempts run out.** The message moves to
   `nest_outbox.dead_letters` with reason `exhausted` and its full error
   history.
4. **An operator requeues it** once the broker is back:
   `OutboxDeadLetters.requeue(id)`. It returns to the outbox with a fresh
   retry budget and the **same id**, so a consumer's inbox still
   recognises it if an earlier attempt did get through.

## Consumer-side inbox

`RefundConsumerService` is a consumer-side template. In a real deployment
it lives in another process and receives the envelope from RabbitMQ
through an `@EventPattern('refunds')` handler; here it exposes
`process(envelope)` so the tests can simulate a delivery and its
duplicate.

It deduplicates with `@nestjs/outbox`'s inbox:
`OutboxInbox.processInTransaction(tx, consumer, envelope.id, work)`
records the message id through the transaction it is given and runs the
work only if the id is new. The record and the work commit together, so
a redelivered message changes nothing, even if the consumer crashed
halfway through the first one.

The transaction it is given is the one `@Transactional` opened
(`getCurrentEntityManager()`), so this side needs no transaction passed
by hand either. In a real consumer the inbox lives in the consumer's own
database, next to the effects it guards, and `OutboxInbox.prune('30d')`
runs from a scheduled job, since nothing prunes it for you.

Together:
- the producer's outbox gives at-least-once *delivery attempts*;
- the consumer's inbox gives at-most-once *effects* per message id.

That is exactly-once *effects*, even with at-least-once delivery.

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.** Both the
  integration test (Postgres via testcontainers) and the visual demo
  (Postgres + RabbitMQ via `docker-compose`) need a Docker daemon.

## Run

```bash
pnpm install                                                 # from monorepo root

# Integration tests (Docker required for Postgres testcontainers):
pnpm -C examples/externalization-with-fallback test:integration

# Visual demo against real Postgres + RabbitMQ:
docker-compose -f examples/externalization-with-fallback/docker-compose.yml up -d
pnpm -C examples/externalization-with-fallback start
# Stop RabbitMQ mid-demo to watch the fallback:
docker-compose -f examples/externalization-with-fallback/docker-compose.yml stop rabbitmq
```

## Key files

- [`src/app.module.ts`](src/app.module.ts) — RabbitMQ with
  `persistent: true`, the transport, `externalizedRoute()`, and the
  retry policy.
- [`src/refund-requested.event.ts`](src/refund-requested.event.ts) —
  `@Externalized({ target: 'refunds', client, headers })`.
- [`src/refund.service.ts`](src/refund.service.ts) — the producer.
- [`src/refund-consumer.service.ts`](src/refund-consumer.service.ts) —
  the consumer's inbox through `@Transactional`.
- [`test/with-fallback.integration.spec.ts`](test/with-fallback.integration.spec.ts)
  — delivery, a rejected emit, recovery on retry, exhaustion into a
  dead letter and an operator requeue, and the inbox on redelivery.

## How the tests stay fast

The broker is a recorded `ClientProxy`; what a real RabbitMQ
acknowledgement means is measured in the outbox package's broker suite.
The relay is off and driven with `runOnce()`, and between attempts the
test moves the waiting message's `available_at` to now rather than
sleeping through the backoff.

## Related examples

- [`externalization-kafka`](../externalization-kafka) — the Kafka record
  in detail.
- [`saga-pattern`](../saga-pattern) — idempotent steps on the handler
  side.

## Further reading

- [ADR-021 — what each transport acknowledges](../../docs/adr/021-externalization-acknowledgement-per-transport.md)
- [ADR-023 — delivery through `@nestjs/outbox`](../../docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
- [`@nestjs/outbox`: retries and the dead-letter queue](https://docs.nestjs.com/reliability/outbox#retries-and-the-dead-letter-queue)
