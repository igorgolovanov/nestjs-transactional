# Spring Modulith Parity Goal

This monorepo aims to provide Spring Modulith-equivalent functionality
for NestJS applications, not just Spring Framework core.

## Scope coverage

**Spring Framework core features (covered in existing packages):**
- `@Transactional` with propagation modes (core)
- `@TransactionalEventListener` with transaction phases (cqrs)
- Multi-DataSource support (typeorm)
- AsyncLocalStorage for transaction context (core)

**Spring Modulith features (partially covered, expansion planned):**
- Event Publication Registry with persistent log — outbox
- `@IntegrationEventsHandler` shortcut — cqrs integration
- Failed / Incomplete / Completed publications API — outbox
- Staleness monitor — outbox
- Republish on restart — outbox
- Completion modes (UPDATE / DELETE / ARCHIVE) — outbox
- `PublishedEvents` test utility — outbox `/testing`
- Event externalization to brokers — SPI,
  `@Externalized`, `outbox-microservices` package,
  [ADR-015](../adr/015-event-externalization-architecture.md).
  One package covers every usable `@nestjs/microservices` transport
  ([DD-016](../dd/016-event-externalization.md)). What a successful
  publish acknowledges varies by transport: Kafka and RabbitMQ match
  Spring Modulith's broker-acked story, core NATS and TCP do not
  acknowledge at all, and gRPC cannot be used. Per-transport table and
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
