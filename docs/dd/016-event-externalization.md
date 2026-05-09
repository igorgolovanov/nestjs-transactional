# DD-016: Implement event externalization (Phase 11)

**Context**: Spring Modulith provides `@Externalized` for routing events
to external message brokers (Kafka, RabbitMQ, JMS, AMQP, ...). Our
existing scope (Phases 5–9) covers internal eventing through the outbox
but does not bridge events to external systems. Production deployments
with microservice architectures need durable, retryable cross-process
delivery — without this, `@nestjs-transactional` falls short of the
production use cases Spring Modulith targets.

**Alternatives considered**:
- Separate per-broker packages (`outbox-kafka`, `outbox-rabbitmq`,
  `outbox-nats`). Rejected: code duplication, more packages to version
  and maintain, fragmented user experience.
- Spring Modulith-style `EventExternalizationConfiguration` builder API.
  Rejected: not idiomatic NestJS — DI + decorator composition is the
  conventional pattern.
- Native broker libraries (`kafkajs`, `amqplib`) directly, bypassing
  `ClientProxy`. Rejected: forces us to manage transport-specific
  connection lifecycle, retries, and serialization for each broker;
  `@nestjs/microservices` already solves this.

**Decision**: Externalization is a first-class feature, implemented as:
- An optional `EventExternalizer` SPI added to `outbox`.
- A new `@nestjs-transactional/outbox-microservices` package that
  provides one `EventExternalizer` implementation backed by
  `@nestjs/microservices` `ClientProxy` — covering every transport
  `@nestjs/microservices` supports (Kafka, RabbitMQ, NATS, JMS, gRPC,
  custom).

**Consequences**:
- One externalization package replaces planned per-broker variants —
  fewer packages to maintain, one mental model for users.
- Reliability (retry, recovery, staleness monitor) inherited from
  `outbox`.
- Naturally composes with the existing NestJS `ClientsModule` pattern
  (see [DD-017](017-reuse-clients-module.md)).
- Future native (broker-specific) implementations can register under the
  same SPI if fine-grained control is needed later.

> See also: [ADR-015](../adr/015-event-externalization-architecture.md)
> for the ADR-form record of the externalization architecture and
> [ADR-016](../adr/016-externalization-reliability-semantics.md) for
> the reliability caveat.
