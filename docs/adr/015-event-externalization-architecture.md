# ADR-015: Event Externalization Architecture

## Status
Accepted — [дата создания]

## Context

After completing Phase 5-9 (outbox infrastructure with
@nestjs-transactional/outbox-core and @nestjs-transactional/outbox-typeorm),
we identified a gap in Spring Modulith parity: external event publishing
to message brokers (Kafka, RabbitMQ, etc.).

Spring Modulith provides @Externalized annotation plus separate
broker-specific artifacts (spring-modulith-events-kafka,
spring-modulith-events-amqp, etc.) for sending events outside the
application boundary while maintaining reliability guarantees through
Event Publication Registry.

For Node.js/NestJS ecosystem, we needed to decide:
1. Whether to add externalization at all (vs leaving to user code)
2. If yes, single package or per-broker packages
3. How to handle ClientProxy registration

Real-world need: production deployments using modular monolith pattern
or microservices integration require reliable event delivery to brokers
beyond local in-process listeners.

## Decision

Implement externalization through:

### 1. EventExternalizer SPI in outbox-core (DD-018)

- EventExternalizer interface defining externalize(event, metadata) contract
- EVENT_EXTERNALIZER DI token for optional implementation registration
- EventPublicationProcessor invokes externalizer after local listeners
  succeed
- Structural port pattern (similar to OUTBOX_LISTENER_REGISTRAR)

### 2. @Externalized decorator and ExternalizationRegistry in outbox-core

- @Externalized class decorator marks events for externalization
- ExternalizationRegistry maps event type names to broker configurations
- Function-based dynamic routingKey and headers (TypeScript-native,
  not SpEL)

### 3. Single package @nestjs-transactional/outbox-microservices (DD-016)

- Implements EventExternalizer using @nestjs/microservices ClientProxy
- Covers Kafka, RabbitMQ, NATS, Redis pub/sub, JMS — all transports
  supported by @nestjs/microservices
- One package vs Spring's four broker-specific artifacts

### 4. Reuse existing ClientsModule (DD-017)

- OutboxMicroservicesModule.forRoot({ defaultClient: token })
- ClientProxy registered separately by user via standard NestJS pattern
  (ClientsModule.register or registerAsync)
- No duplicate connection pool management

### 5. Atomicity and ordering (DD-019)

- Single unit: local listeners + externalization either both succeed
  or both fail
- Order: local listeners first, externalization after
- Idempotency required from handlers (at-least-once on retry)

## Alternatives Considered

### Per-broker packages (outbox-kafka, outbox-rabbitmq, outbox-nats)

Rejected:
- Code duplication between similar implementations
- Maintenance burden multiplied per broker
- @nestjs/microservices already provides unified abstraction

### Native broker library integration (kafkajs, amqplib direct)

Rejected as primary approach:
- Less idiomatic for NestJS users
- ClientProxy is well-known pattern in NestJS ecosystem
- Native libraries may be added later as separate packages for
  fine-grained control if real users need stricter semantics

### Custom ClientProxy registration in our module

Rejected:
- Duplicates standard NestJS ClientsModule
- Confusion with two registration patterns
- Real users typically already have ClientsModule for other purposes

### Spring-style EventExternalizationConfiguration builder

Rejected:
- Decorator + DI is more idiomatic in NestJS ecosystem
- Builder API was Spring's solution for its annotation processing
  limitations
- Function-based options in decorator achieve same flexibility cleaner

## Consequences

### Positive
- Single externalization package covers all brokers users typically need
- Reuses standard NestJS ClientsModule — minimal new patterns to learn
- Reliability inherited from outbox infrastructure (retry, recovery)
- Function-based options leverage TypeScript type system

### Negative
- Headers and broker-specific features limited by ClientProxy
  abstraction capabilities
- Native broker fine-grained featur
