# @nestjs-transactional/outbox-microservices

## 1.0.0-alpha.3

### Patch Changes

- [#8](https://github.com/igorgolovanov/nestjs-transactional/pull/8) [`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035) Thanks [@igorgolovanov](https://github.com/igorgolovanov)! - Pin npm dist-tag to `alpha` while in the pre-release cohort.

  Each package's `publishConfig` now declares `"tag": "alpha"`, so
  `npm publish` (driven by `changesets/action` from the Release
  workflow) places every pre-release into the `alpha` dist-tag instead
  of `latest`. Previously the `release` script (`changeset publish`)
  did not pass `--tag`, and changesets does not infer the pre-release
  tag automatically — so the second and every subsequent
  pre-release publish wrote the new version into `latest`, leaving
  the `alpha` tag pointing at `1.0.0-alpha.0` while `latest` advanced
  to the freshest pre-release. That was already the case on
  `@nestjs-transactional/typeorm` and `@nestjs-transactional/outbox-typeorm`
  after the TypeORM 1.0 bump (`1.0.0-alpha.0` → `1.0.0-alpha.1`) and on
  `@nestjs-transactional/cqrs` after ADR-020 (`1.0.0-alpha.0` →
  `1.0.0-alpha.2`); manual `npm dist-tag` runs corrected the registry.

  `publishConfig.tag` is declarative per-package and survives
  `changesets/action` updates without changes to the release workflow
  or root scripts. The setting will be removed (or flipped to `latest`)
  as part of the `pnpm changeset pre exit` step before promoting the
  cohort to stable `1.0.0`.

  No functional change to any package's runtime behaviour or public
  API — `package.json` metadata only.

- Updated dependencies [[`f2c66f9`](https://github.com/igorgolovanov/nestjs-transactional/commit/f2c66f944eabe27ac0a01f8fe1764b4edc13f035)]:
  - @nestjs-transactional/outbox@1.0.0-alpha.3

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
