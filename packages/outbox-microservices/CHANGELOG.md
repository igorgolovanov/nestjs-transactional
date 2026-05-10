# @nestjs-transactional/outbox-microservices

## 1.0.0-alpha.0

### Minor Changes

- [`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - First public alpha release.

  Event externalization to message brokers via `@nestjs/microservices`
  `ClientProxy` — Spring Modulith `@Externalized` parity collapsed
  into one package covering every transport the upstream supports
  (Kafka, RabbitMQ, NATS, JMS, gRPC, custom). Architectural rationale
  in ADR-015.
  - `MicroservicesEventExternalizer` plugs into
    `@nestjs-transactional/outbox` as the `EventExternalizer`
    implementation. The processor invokes it AFTER local listeners
    succeed; if either step fails the publication finalises as
    `FAILED` and surfaces in `FailedEventPublications.resubmit`
    (DD-019 single-unit atomicity).
  - `OutboxMicroservicesModule.forRoot({ defaultClient })` /
    `forRootAsync({...})` reuses the application's existing
    `ClientsModule` registration (DD-017 — no parallel connection
    pool, no second mental model). Per-event broker routing via
    `@Externalized({ client })`.
  - Module is `@Global()` so the bound `EVENT_EXTERNALIZER` is visible
    to every per-DS outbox processor without explicit imports —
    multi-DataSource setups need no special wiring.
  - `validateOnBootstrap: true` (default) resolves the
    `defaultClient` once at `OnApplicationBootstrap` and throws a
    descriptive error if the token is unbound.

  ⚠️ **Reliability semantics — read [ADR-016] before production use.**
  The `@nestjs/microservices` `ClientProxy.emit()` API does NOT
  propagate broker-side delivery failures; the externalizer reports
  success when the dispatch is handed off to the transport, not when
  the broker durably acknowledges. Mitigation strategies (idempotent
  producers, consumer-side inbox / dedup, broker-aware externalizers)
  documented in `packages/outbox-microservices/README.md` and
  demonstrated in `examples/externalization-with-fallback`.

  [ADR-016]: https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/016-externalization-reliability-semantics.md

  Peer deps: `@nestjs-transactional/core`, `@nestjs-transactional/outbox`,
  `@nestjs/microservices`. Public alpha.

### Patch Changes

- Updated dependencies [[`f7b55e1`](https://github.com/igorgolovanov/nestjs-transactional/commit/f7b55e173248e2a701d99e63c40ff7e5a814a4a1)]:
  - @nestjs-transactional/outbox@1.0.0-alpha.0
