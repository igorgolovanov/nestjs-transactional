# Scope and coverage

What `@nestjs-transactional` covers, what it leaves to NestJS's own
modules, and what is out of scope. The last part compares the result
with Spring, for readers who know it.

## What the library covers

- **Declarative transactions** (core): `@Transactional`, all seven
  propagation modes, isolation, rollback rules, commit and rollback
  hooks, retry of serialization failures and deadlocks.
- **Transactional context across `await`** (core), on
  `AsyncLocalStorage`, so nothing passes a transaction by hand.
- **Repositories that join the transaction** (typeorm), and multiple
  DataSources in one application.
- **Commit-aware event handlers** (cqrs): `@TransactionalEventsHandler`
  at a chosen transaction phase, command and query handlers in a
  transaction, and `{ transaction }` in the `EventBus`'s dispatcher
  context.
- **One transaction with NestJS's reliability modules**: an outbox
  message (outbox) and a workflow instance or signal (workflows) commit
  with the business rows.

## Compared with Spring

**Spring Framework core, and where it lives here:**
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

**Next to the NestJS reliability modules, from 3.0.0:**

Spring Modulith is one framework that owns its event publication.
NestJS chose separate first-party modules instead, and this repository
sits beside them rather than replacing them: it supplies the ambient
transaction they take as an argument.

| Concern | Spring | NestJS, with this repository |
| --- | --- | --- |
| Declarative transactions, propagation | `@Transactional` | `@Transactional` (core) |
| Phase-aware listeners | `@TransactionalEventListener` | `@TransactionalEventsHandler` (cqrs) |
| Event publication in the business transaction | Event Publication Registry | `@nestjs/outbox` + the outbox bridge |
| Durable processes, sagas | Spring Modulith has none; Temporal or a state machine | `@nestjs/workflows` + the workflows bridge |
| Retry of a failed transaction | Spring Retry around `@Transactional` | `@Transactional({ retry })` (DD-032) |

How each module meets `@Transactional`, including those with nothing to
bridge (locks, idempotency):
[the reliability modules guide](../guides/reliability-modules.md).

**Explicitly out of scope:**
- Module boundary verification (Spring Modulith's `ApplicationModuleVerification`)
  — use `@nx/enforce-module-boundaries` or similar for this
- Documentation generation (Spring Modulith's `Documenter`) — use TypeDoc

## Positioning note

The scope once aimed at Spring Modulith equivalence, after comparing with
Spring Modulith 2.0.5's documentation
(https://docs.spring.io/spring-modulith/reference/events.html): production
systems need delivery guarantees, not only transactions. From 3.0.0 the
delivery itself belongs to NestJS's first-party modules (ADR-023), and
this repository supplies the transaction they write in.

## Spring Framework reference points

The transaction API follows Spring's where it can, so these are useful
reference points:

- **Spring @Transactional**: https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/annotations.html
- **Propagation modes**: https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html
- **@TransactionalEventListener**: https://docs.spring.io/spring-framework/reference/core/aop/introduction-defn.html (implicit)
- **Spring Modulith Event Publication Registry**: https://docs.spring.io/spring-modulith/reference/events.html

We do not pursue 100% feature parity — we take what makes sense in the
Node.js ecosystem and covers real use cases of NestJS applications.
