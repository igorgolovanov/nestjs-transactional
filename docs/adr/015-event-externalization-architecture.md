# ADR-015: Event externalization architecture

- **Status**: Accepted
- **Date**: 2026-04-26
- **Related**:
  - ADR-006 (outbox pattern rationale)
  - ADR-007 (outbox architecture: core + typeorm split)
  - ADR-014 (class-level handler API)
  - ADR-016 (externalization reliability semantics with `@nestjs/microservices`)
  - DD-016 (event externalization scope and design)
  - DD-017 (reuse `ClientsModule` for `ClientProxy` registration)
  - DD-018 (`EventExternalizer` SPI as a structural port)
  - DD-019 (atomicity and ordering for hybrid delivery)

> **Note (Phase 12 package rename, 2026-04-26):** The package referred to
> as `@nestjs-transactional/outbox-core` in this ADR's original text was
> renamed to `@nestjs-transactional/outbox` in Phase 12. Body references
> have been updated inline; the externalization architecture is unchanged.

## Context

After completing Phases 5–9 (outbox infrastructure with
`@nestjs-transactional/outbox` and
`@nestjs-transactional/outbox-typeorm`), the gap to Spring Modulith
parity was external event publishing to message brokers — Kafka,
RabbitMQ, NATS, JMS, gRPC, etc. Spring Modulith ships `@Externalized`
plus separate broker-specific artefacts
(`spring-modulith-events-kafka`, `spring-modulith-events-amqp`,
`spring-modulith-events-jms`, `spring-modulith-events-messaging`)
that send events outside the application boundary while keeping
reliability guarantees from the Event Publication Registry.

For Node.js / NestJS we needed to answer three architectural
questions:

1. Should externalization belong in this monorepo at all, or be
   left to user code on top of the outbox?
2. If yes — one package across all brokers, or one per broker?
3. Where does broker-side `ClientProxy` registration live — in our
   module, or reused from the user's existing `ClientsModule`?

Real-world driver: production deployments using a modular monolith
pattern or microservices integration require reliable event delivery
to brokers beyond local in-process listeners. Without that piece, the
outbox stops at the application boundary and users fall back to
ad-hoc producer code — which is exactly the failure mode the outbox
pattern was supposed to prevent.

## Decision

Externalization is a first-class feature of the monorepo, implemented
as five composable pieces:

### 1. `EventExternalizer` SPI in `outbox` (DD-018)

- `EventExternalizer` interface — `externalize(event, metadata): Promise<void>`.
- `EVENT_EXTERNALIZER` DI token (Symbol) for optional binding.
- `EventPublicationProcessor` injects the externalizer with
  `@Optional()` and invokes it after the local listener succeeds.
- Structural port pattern, matching `OUTBOX_LISTENER_REGISTRAR`
  (DD-012) and `OUTBOX_PUBLICATION_SCHEDULER` (DD-011).

### 2. `@Externalized` + `ExternalizationRegistry` in `outbox`

- `@Externalized` class decorator marks an event for externalization
  with `target`, optional `client`, optional `routingKey(event)`,
  optional static or function-derived `headers`. Generic `<TEvent>`
  on the decorator types the callbacks.
- `ExternalizationRegistry` indexes `@Externalized`-decorated event
  classes against `EventTypeRegistry` at module init and resolves
  per-publication metadata at processor time.
- Function-based dynamic options (`routingKey: (e) => e.tenantId`)
  leverage the TypeScript type system directly; no separate
  expression language à la Spring SpEL.

### 3. Single `@nestjs-transactional/outbox-microservices` package (DD-016)

- `MicroservicesEventExternalizer` implements `EventExternalizer` via
  `@nestjs/microservices` `ClientProxy.emit()`.
- Covers every transport `@nestjs/microservices` supports — Kafka,
  RabbitMQ, NATS, Redis pub/sub, JMS, gRPC, custom.
- One package replaces the four Spring Modulith artefacts.

### 4. Reuse the user's existing `ClientsModule` (DD-017)

- `OutboxMicroservicesModule.forRoot({ defaultClient: TOKEN })`
  accepts the DI token of a `ClientProxy` the user has already
  registered through `ClientsModule.register()` /
  `ClientsModule.registerAsync()`.
- The package does NOT register clients itself — no parallel
  connection pool, no second mental model.
- Per-event override: `@Externalized({ client })` — the externalizer
  resolves whichever proxy the metadata or the default selects.

### 5. Atomicity and ordering (DD-019)

- **Single unit**: one publication row covers all delivery channels
  for the event. Either every channel succeeded, or the row is
  retried.
- **Execution order**: local listener first, externalization after —
  cheap in-process failures fail fast before we touch a broker.
- **Idempotency requirement**: handlers and broker consumers must
  tolerate duplicates; the at-least-once retry contract from the
  outbox machinery means a successful local handler may run again
  on a later retry.

## Alternatives considered

### Per-broker packages (`outbox-kafka`, `outbox-rabbitmq`, `outbox-nats`)

Rejected:

- Code duplication between similar implementations.
- Maintenance burden multiplied per broker — bug fixes ship N times.
- `@nestjs/microservices` already provides the unified abstraction
  the rejected approach would re-derive.

The future is not closed off, however. Native broker adapters can
ship under the same `EVENT_EXTERNALIZER` SPI (DD-018) without
breaking existing users — see ADR-016 *Future remediation* for the
specific reliability angle that may motivate them.

### Native broker library integration (`kafkajs`, `amqplib` direct)

Rejected as the primary approach:

- Less idiomatic for NestJS users.
- `ClientProxy` is the well-known pattern in the NestJS ecosystem.
- Native libraries can be added later as separate packages for
  fine-grained control if real users need stricter semantics — see
  ADR-016 for the case that may already motivate this.

### Custom `ClientProxy` registration inside our module

Rejected:

- Duplicates the standard NestJS `ClientsModule`.
- Two registration patterns confuse users and waste connection
  pools.
- Real applications using `@nestjs/microservices` typically already
  have `ClientsModule` registered for other reasons (consuming
  inbound messages, RPC, emitting outside the outbox). Reusing that
  registration is the lower-friction default.

### Spring-style `EventExternalizationConfiguration` builder

Rejected:

- Decorator + DI is more idiomatic in the NestJS ecosystem.
- Builder API was Spring's workaround for annotation-processing
  limitations that do not apply here.
- Function-based options on the decorator achieve the same
  flexibility with less ceremony and full TypeScript inference.

## Consequences

### Positive

- A single externalization package covers every broker users
  typically need; one mental model, one set of release notes.
- Reuses the standard NestJS `ClientsModule` pattern — there are
  no new module-wiring conventions to learn.
- Reliability machinery from `outbox` (retry, recovery,
  staleness monitor, operator APIs) applies uniformly to local
  and externalised delivery without duplication.
- Function-based `routingKey` / `headers` leverage the TypeScript
  type system; the decorator stays small.
- The structural-port SPI leaves room for stricter native adapters
  without an API break.

### Negative

- Broker-specific producer features that `ClientProxy` does not
  expose (Kafka custom partitioner, AMQP exchange types beyond the
  default, NATS JetStream stream config, ...) are not directly
  reachable through `@Externalized` — users that need them either
  configure the `ClientProxy` itself, fall back to NestJS-native
  `ClientProxy` calls outside the outbox, or wait for a native
  adapter.
- Headers and `routingKey` are accepted on `@Externalized` but not
  yet applied to the wire payload (Phase 11.3 limitation — broker
  semantics differ enough that a uniform translation requires a
  per-transport iteration).
- Documentation must clearly state the `ClientsModule` prerequisite
  and the headers limitation; the bootstrap validation in
  `OutboxMicroservicesModule` mitigates the former by failing fast
  on a missing `defaultClient` binding.

### Reliability caveat (introduced by ADR-016)

The chosen `ClientProxy` abstraction comes with a fire-and-forget
delivery semantic that this ADR cannot remove on its own.
[ADR-016](016-externalization-reliability-semantics.md) records the
finding from Phase 11.4: `ClientProxy.emit()` resolves successfully
when the proxy considers the dispatch handed off to the transport,
not when the broker has durably acknowledged the message. With an
unreachable broker or a transport in default fire-and-forget mode,
`emit()` reports success and the outbox publication transitions to
`COMPLETED` even though no message landed.

The externalization layer cannot detect a silent broker-side failure
from this signal alone — there is nothing to detect from. The
`outbox` retry / staleness / `FailedEventPublications.resubmit`
machinery only fires when the externalizer returns an error, which
in this configuration it does not.

This does not invalidate the architecture in this ADR — the SPI,
decorator, registry, and module wiring all stand. It scopes the
delivery guarantee that
`@nestjs-transactional/outbox-microservices` provides out of the
box. Users requiring stricter semantics have three paths, all
documented in ADR-016 and in the package README:

1. Configure the underlying `ClientProxy` for stronger acknowledgment
   (Kafka `acks: 'all'` + idempotent producer, RabbitMQ
   confirm-channel, NATS JetStream with explicit ack).
2. Combine with consumer-side acknowledgment / inbox patterns to
   detect gaps after the fact.
3. Wait for a native broker adapter under the same
   `EVENT_EXTERNALIZER` SPI — that is the future-work path the SPI
   was designed to leave open (DD-018).

## Spring Modulith mapping

| Spring Modulith                                | Here                                                                  |
|------------------------------------------------|-----------------------------------------------------------------------|
| `@Externalized`                                | `@Externalized` (`outbox`)                                       |
| `EventExternalizer` (Spring's interface)       | `EventExternalizer` (`outbox`, structurally similar)             |
| `spring-modulith-events-kafka`                 | one transport of `outbox-microservices`                               |
| `spring-modulith-events-amqp`                  | one transport of `outbox-microservices`                               |
| `spring-modulith-events-jms`                   | one transport of `outbox-microservices`                               |
| `spring-modulith-events-messaging`             | one transport of `outbox-microservices`                               |
| `EventExternalizationConfiguration` builder    | `OutboxMicroservicesModule.forRoot` + `@Externalized` per event       |
| Spring SpEL routing key                        | Function-based `routingKey: (event) => ...` on `@Externalized`        |
| Spring router/filter combinators               | Function-based `headers: (event) => ...` (combinable in user code)    |

The Spring API split (one artefact per broker) reflects Java
classpath ergonomics; the NestJS world has no equivalent constraint
and the unified `ClientProxy` abstraction lets a single package
serve every transport. Migration from Spring Modulith should map
cleanly: `@Externalized` lifts directly, the broker setup moves
from a Spring auto-configuration to the user's `ClientsModule`.

## References

- `packages/outbox/src/externalization/event-externalizer.ts`
- `packages/outbox/src/externalization/externalized.decorator.ts`
- `packages/outbox/src/externalization/externalization-registry.ts`
- `packages/outbox-microservices/src/externalizer/microservices-event-externalizer.ts`
- `packages/outbox-microservices/src/module/outbox-microservices.module.ts`
- `docs/architecture/event-externalization.md`
- ADR-016 — externalization reliability semantics with `@nestjs/microservices`
