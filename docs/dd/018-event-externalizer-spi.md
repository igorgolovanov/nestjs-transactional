# DD-018: `EventExternalizer` SPI as a structural port

**Context**: `outbox` should not import a specific externalization
implementation at compile time, since externalization is optional and
may have multiple backends. We need an abstraction that supports the
same `@Optional()` injection pattern already used for
`OUTBOX_LISTENER_REGISTRAR` and `OUTBOX_PUBLICATION_SCHEDULER`.

**Alternatives considered**:
- Dynamic `require()` at runtime to load the externalization package if
  installed. Rejected: breaks bundlers (webpack, esbuild, Vite), creates
  hidden dependencies, awkward error handling, non-idiomatic for NestJS
  DI.
- Hard compile-time dependency on a concrete implementation. Rejected:
  forces every `outbox` user to install `@nestjs/microservices`
  even when they only need internal eventing.

**Decision**: `outbox` defines an `EventExternalizer` interface
and an `EVENT_EXTERNALIZER` DI token (Symbol). Concrete implementations
(e.g. `MicroservicesEventExternalizer`) register themselves under this
token via `useClass` or `useExisting`. `EventPublicationProcessor`
injects it with `@Optional()` — when no externalizer is bound, the
outbox runs in internal-only mode.

**Consequences**:
- Consistent with the existing structural-port pattern
  (`OUTBOX_LISTENER_REGISTRAR` per [DD-012](012-integration-events-handler.md),
  `OUTBOX_PUBLICATION_SCHEDULER` per [DD-011](011-hybrid-event-publishing.md)).
- Externalization is genuinely optional; the outbox works without it.
- Easy to add alternative externalizer implementations (native Kafka,
  native AMQP, custom transports) without touching `outbox`.
- Bundler-friendly: no dynamic require, no hidden module resolution.
