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
- Event Publication Registry with persistent log — outbox (Phase 5)
- `@IntegrationEventsHandler` shortcut — cqrs integration (Phase 7)
- Failed / Incomplete / Completed publications API — outbox (Phase 5)
- Staleness monitor — outbox (Phase 5)
- Republish on restart — outbox (Phase 5)
- Completion modes (UPDATE / DELETE / ARCHIVE) — outbox (Phase 5)
- `PublishedEvents` test utility — outbox `/testing` (Phase 8)
- Event externalization to brokers — Phase 11 in progress: SPI,
  `@Externalized`, `outbox-microservices` package,
  [ADR-015](../adr/015-event-externalization-architecture.md),
  reliability caveat in [ADR-016](../adr/016-externalization-reliability-semantics.md).
  One package covers all `@nestjs/microservices` transports
  ([DD-016](../dd/016-event-externalization.md)). End-to-end working
  example pending in Phase 11.5b. Reliability semantics weaker than
  Spring Modulith's broker-acked story — see ADR-016 for the
  trade-off and three production mitigation strategies.

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
