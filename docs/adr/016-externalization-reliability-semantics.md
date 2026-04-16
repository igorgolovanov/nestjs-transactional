# ADR-016: Externalization reliability semantics with `@nestjs/microservices`

- **Status**: Accepted (with documented limitation)
- **Date**: 2026-04-25
- **Related**:
  - ADR-006 (outbox pattern rationale)
  - ADR-007 (outbox architecture: core + typeorm split)
  - DD-016 (event externalization scope and design)
  - DD-017 (reuse of `ClientsModule` for `ClientProxy` registration)
  - DD-018 (`EventExternalizer` SPI as a structural port)
  - DD-019 (single-unit atomicity and execution order)

> **Note (Phase 12 package rename, 2026-04-26):** Where this ADR refers
> to `outbox-core`'s reliability machinery (retry, recovery, staleness
> monitor, etc.), that package was renamed to `@nestjs-transactional/outbox`
> in Phase 12. Body references updated inline; the documented reliability
> limitation and the three mitigation strategies are unchanged.

## Context

Phase 11.4 set out to add real-broker integration tests to
`@nestjs-transactional/outbox-microservices` — Kafka and RabbitMQ via
`testcontainers`, asserting both happy-path delivery and a "broker
unreachable → publication FAILED" reliability path.

While building the reliability test we discovered that, with the
`@nestjs/microservices` `ClientProxy` abstraction this package depends
on (DD-016, DD-017), `ClientProxy.emit()` does NOT propagate
broker-side failures to its caller in a way that the externalizer can
observe. Concretely:

- Configuring a `ClientKafka` with an unreachable broker
  (`brokers: ['127.0.0.1:1']` + `retry: { retries: 0 }` +
  `connectionTimeout: 1_000` + `producer.retry: { retries: 0 }`) and
  calling `client.emit(target, event)` produces a completed Observable.
- `firstValueFrom(client.emit(...))` resolves successfully.
- `MicroservicesEventExternalizer.externalize()` therefore returns
  without throwing.
- `EventPublicationProcessor.processOne` finalises the publication
  as `COMPLETED`, even though no message ever reached a broker.

A complementary observation: even when a real broker IS up
(`testcontainers/kafka` running, topic pre-created, group coordinator
joined), an independent `kafkajs` consumer subscribed before publish
does not reliably observe the produced message. NestJS `ClientKafka`
emits a `[Connection] Response GroupCoordinator … "The group
coordinator is not available"` error during init that surfaces as a
log line but does not propagate to `emit()`. The end-to-end delivery
guarantee at this layer is weaker than naive reading of the abstraction
suggests.

This is not a bug in our code. It is a consequence of the fire-and-forget
semantics of `ClientProxy.emit()` across all transports
`@nestjs/microservices` supports: the Observable completes when the
proxy considers the dispatch *handed off to the transport*, not when
the broker has *durably acknowledged* the message. Different
transports interpret "handed off" differently — Kafka's default
producer with `acks: 'leader'` is closer to broker-acknowledged than
RabbitMQ's default fire-and-forget publish, but in both cases there
are realistic failure modes (network partition during ack, broker
crash before fsync, configuration drift, ...) where `emit()` reports
success and the message is never delivered.

The unit-level mock tests written for Phases 11.1–11.3 verify our
own contract — externalizer wraps `emit()` errors in
`ExternalizationError`, processor maps them to `FAILED`, etc. — but
they cannot exercise the broker layer. The Phase 11.4 integration
tests would have closed that gap; the discovery above means they
cannot, at least not via the path we set out to take.

## Decision

We accept the silent-success behavior as the de-facto contract of
`MicroservicesEventExternalizer` in this iteration, and document it
prominently for production users. Specifically:

1. **No real-broker integration tests in `outbox-microservices`.**
   The Phase 11.4 tests are removed. The `testcontainers` /
   `kafkajs` / `amqplib` / `amqp-connection-manager` dev-dependencies
   are dropped. The `jest.integration.config.js` and the
   `test:integration` npm script are removed.

2. **A new mock-based test pins the silent-success behavior.**
   `test/unit/microservices-event-externalizer-silent-success.spec.ts`
   asserts that an `Observable` that completes without error — which
   is exactly what an unreachable-broker `emit()` looks like to our
   externalizer — produces a resolved `externalize()` Promise. The
   test exists to document the behavior and to surface any future
   regression away from this contract as a behavioral diff.

3. **The package README documents the limitation up front.** A
   "Reliability semantics" section is added near the top of
   `packages/outbox-microservices/README.md`, before Installation,
   so that users adopting the package see it before they make
   production decisions. Three mitigation strategies are listed.

4. **The roadmap records the limitation** in the Phase 11 entry of
   [`docs/roadmap/README.md`](../roadmap/README.md) alongside this
   ADR's reference, so the constraint is visible during future
   planning.

5. **A future iteration may ship broker-aware externalizers** (native
   `kafkajs` / native `amqplib` / native `nats` adapters registered
   under the same `EVENT_EXTERNALIZER` SPI from DD-018) that issue
   real round-trip acknowledgments and propagate broker errors. Such
   adapters would supersede `MicroservicesEventExternalizer` for
   deployments that need stricter delivery guarantees. They are not
   scoped to Phase 11 — this ADR remains the contract of record
   until that work is opened.

## Alternatives considered

- **Keep the failing integration tests as `it.skip()` or `xit.todo()`**
  with TODO comments. Rejected: skipped tests rot, and the limitation
  belongs in user-facing documentation, not in a hidden test
  annotation.

- **Drop `@nestjs/microservices` and ship native `kafkajs` /
  `amqplib` adapters in this iteration.** Rejected: large scope
  expansion; the reuse-`ClientsModule` decision (DD-017) was approved
  precisely because it minimises adoption friction for the common
  case. Native adapters can be added later under the same SPI without
  breaking existing users.

- **Configure `acks: 'all'` and a transactional producer on the
  Kafka client to force broker acknowledgment.** Investigated and
  rejected for this iteration: requires per-transport configuration
  knowledge that the abstraction was supposed to hide, and only
  partially solves the problem (RabbitMQ confirm-channel,
  NATS `JetStream` ack, gRPC response, ... each need their own
  per-transport tuning). Would also require us to expose that
  configuration through `OutboxMicroservicesOptions` rather than
  letting users tune it on their own `ClientsModule.register()` —
  conflicting with DD-017.

- **Investigate the `[GroupCoordinator] not available` log and the
  consumer-side reception issues until they're resolved.** Rejected:
  the consumer-side observations are tangential to our contract (we
  produce, we don't consume) and the silent-success of `emit()` is
  the load-bearing finding that drives this ADR regardless.

## Consequences

### Positive

- The actual contract of `MicroservicesEventExternalizer` is honestly
  documented; the package README does not over-promise.
- Mitigation strategies are surfaced where users will see them
  before adopting in production.
- The SPI from DD-018 leaves room for stricter alternatives without a
  breaking change — broker-aware externalizers can ship later under
  the same `EVENT_EXTERNALIZER` token.
- The unit + module-integration tests already in place verify
  everything we own; we are not silently reducing test coverage —
  we are clarifying what those tests can and cannot prove.

### Negative

- No automated, CI-runnable signal that `MicroservicesEventExternalizer`
  works against a real broker. Manual verification or downstream
  integration in user applications fills the gap.
- Production users adopting the package without reading the README
  may assume stricter guarantees than the package provides. The
  prominent placement of the reliability section is the mitigation;
  if user feedback shows it is still missed, we may consider
  emitting a warning at bootstrap.
- The `outbox` reliability machinery (retry, recovery,
  staleness monitor, `FailedEventPublications.resubmit`) only runs
  when a publication is actually marked `FAILED`. Silent broker
  failures bypass it — the publication shows `COMPLETED` and is
  never retried by us. End-to-end delivery requires either
  application-side acknowledgment / inbox patterns on the consumer,
  or a future broker-aware externalizer.

## Mitigation strategies for production

These ship with the README so users have actionable guidance:

1. **Use a transport-level idempotent / confirm pattern at the
   producer layer.** Configure the underlying `ClientProxy` for
   stronger acknowledgment before passing it to
   `OutboxMicroservicesModule` — e.g. Kafka `acks: 'all'` plus
   `idempotent: true`, RabbitMQ confirm-channel via
   `amqp-connection-manager`. The package does not interfere with
   any such configuration; it reuses whatever proxy the user
   registered (DD-017).

2. **Combine with consumer-side acknowledgment / inbox patterns.**
   The receiving system should track processed message ids and
   surface gaps to operators. The outbox publication's listener id
   plus a domain-level event id is enough to deduplicate on the
   consumer.

3. **Wait for the broker-aware externalizer iteration** if neither
   of the above is feasible and at-least-once delivery to the broker
   is a hard requirement. The SPI shape stays the same — no client
   code changes required when those adapters land.

## References

- `packages/outbox-microservices/README.md` — Reliability semantics
  section.
- `packages/outbox-microservices/test/unit/microservices-event-externalizer-silent-success.spec.ts`
  — silent-success contract pinned by mock tests.
- [`docs/roadmap/README.md`](../roadmap/README.md) — Phase 11
  entry references this ADR.
