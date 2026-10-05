# Spring Modulith Parity Goal

This monorepo aims to provide Spring Modulith-equivalent functionality
for NestJS applications, not just Spring Framework core.

## Scope coverage

**Spring Framework core features (covered in existing packages):**
- `@Transactional` with propagation modes (core)
- `@TransactionalEventListener` with transaction phases (cqrs)
- Multi-DataSource support (typeorm)
- AsyncLocalStorage for transaction context (core)

**Spring Modulith's event publication, from 3.0.0:**

Until 2.x this repository shipped its own Event Publication Registry,
mapped one to one onto Spring Modulith's: lifecycle states, completion
modes, the Failed / Incomplete / Completed APIs, the staleness monitor,
republishing on restart, `PublishedEvents`. From 3.0.0 delivery belongs
to `@nestjs/outbox` (ADR-023), and that one-to-one claim is withdrawn.
What remains, mapped honestly:

| Spring Modulith | 3.0.0 |
| --- | --- |
| Publication written in the business transaction | `OutboxEventPublisher.publish()` inside `@Transactional` |
| `@ApplicationModuleListener` | `@IntegrationEventsHandler` (in-memory), `@OnOutboxMessage` (durable, `@nestjs/outbox`) |
| Retry of incomplete publications | `@nestjs/outbox` retries with backoff; dead letters for the rest |
| `FailedEventPublications.resubmit` | `OutboxDeadLetters.requeue` |
| Republish on restart / staleness | leases: a crashed instance's messages are reclaimed by any other |
| Completion modes, audit of completed publications | none: a delivered message is removed |
| `@Externalized` to brokers | `@Externalized` + `ClientProxyTransport` |
| `PublishedEvents` test utility | none; `OutboxRelay.runOnce()` in integration tests |

What a broker's acknowledgement means varies by transport: Kafka and
RabbitMQ match Spring Modulith's broker-acked story, core NATS and TCP do
not acknowledge at all, and gRPC cannot be used. Per-transport table and
measurements in
[ADR-021](../adr/021-externalization-acknowledgement-per-transport.md).

**Explicitly out of scope:**
- Module boundary verification (Spring Modulith's `ApplicationModuleVerification`)
  — use `@nx/enforce-module-boundaries` or similar for this
- Documentation generation (Spring Modulith's `Documenter`) — use TypeDoc

## Positioning note

This is a deliberate scope commitment made after comparing with Spring
Modulith 2.0.5 documentation
(https://docs.spring.io/spring-modulith/reference/events.html).
Prior positioning of "Spring Framework equivalent" was insufficient —
production systems need the delivery guarantees Spring Modulith provides.

## Spring Framework reference points

Since we model the API on Spring, useful reference points:

- **Spring @Transactional**: https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html
- **Propagation modes**: https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html
- **@TransactionalEventListener**: https://docs.spring.io/spring-framework/reference/core/aop/introduction-defn.html (implicit)
- **Spring Modulith Event Publication Registry**: https://docs.spring.io/spring-modulith/reference/events.html

We do not pursue 100% feature parity — we take what makes sense in the
Node.js ecosystem and covers real use cases of NestJS applications.
