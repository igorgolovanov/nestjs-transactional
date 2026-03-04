# Event externalization

> **TL;DR.** `@Externalized` marks an event for delivery to a message
> broker. After the local outbox listener completes successfully, the
> bound `EventExternalizer` is invoked with resolved metadata and
> sends the event over `@nestjs/microservices` `ClientProxy`. The
> outbox publication transitions to `COMPLETED` only when both steps
> resolve. Reliability is documented in
> [ADR-016](../adr/016-externalization-reliability-semantics.md);
> read it before shipping to production.

This document expands [ADR-015](../adr/015-event-externalization-architecture.md)
with diagrams, concrete component descriptions, the end-to-end
sequence, the Spring Modulith mapping, and a reliability semantics
section. It is the load-bearing reference for anyone evaluating the
externalization story for their application.

## High-level architecture

```
                       ┌──────────────────────────────────────────────┐
                       │     Application code (your handlers)         │
                       │                                              │
                       │   @Transactional placeOrder() {              │
                       │     await orders.save(order);                │
                       │     await publisher.publish(orderPlaced);    │
                       │   }                                          │
                       └────────────────────┬─────────────────────────┘
                                            │
                                            ▼
┌────────────────────── outbox ─────────────────────────────────┐
│                                                                    │
│  OutboxEventPublisher.publish()                                    │
│    │                                                               │
│    ├── EventPublicationRegistry.register()  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ┐
│    │                                                               │    │
│    │                                  ┌─ EventTypeRegistry         │    │
│    │                                  ├─ ExternalizationRegistry ◄─│────┘
│    │                                  └─ OutboxListenerRegistry    │
│    │                                                               │
│    └── persisted as event_publication row (status: PUBLISHED)      │
│                                                                    │
│  EventPublicationProcessor (poll loop)                             │
│    │                                                               │
│    ├── tryClaim → PROCESSING                                       │
│    ├── listenerRegistry.invoke(event)         (local listener)     │
│    ├── tryExternalize(event, publication)     (NEW — Phase 11)     │
│    │     └── ExternalizationRegistry.buildMetadata(...)            │
│    │     └── externalizer.externalize(event, metadata)             │
│    └── markCompleted / markFailed                                  │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼  EVENT_EXTERNALIZER (DI port)
┌────────── outbox-microservices ────────────────────────────────────┐
│                                                                    │
│  MicroservicesEventExternalizer.externalize(event, metadata)       │
│    │                                                               │
│    ├── ModuleRef.get<ClientProxy>(metadata.client ?? defaultClient)│
│    └── firstValueFrom(client.emit(metadata.target, event))         │
│                                                                    │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼  user's ClientsModule.register()
┌─────────────── @nestjs/microservices ──────────────────────────────┐
│                                                                    │
│  ClientKafka / ClientRMQ / ClientNats / ClientGrpc / ...           │
│                                                                    │
└──────────────────────────────────┬─────────────────────────────────┘
                                   │
                                   ▼
                        external broker (Kafka, RabbitMQ, ...)
```

The dashed line into `ExternalizationRegistry` is the side input the
processor consults for each publication: "is this event type
`@Externalized`? if so, with what target / routing key / headers /
client?". A negative answer skips the externalization step entirely
without changing the rest of the flow.

## Components

### `EventExternalizer` (SPI, in `outbox`)

Interface: `externalize(event: unknown, metadata: ExternalizationMetadata): Promise<void>`.

Bound through the `EVENT_EXTERNALIZER` DI token. The
`EventPublicationProcessor` injects it with `@Optional()`, so the
outbox runs with externalization disabled when no implementation is
bound — useful for in-process-only deployments and tests.

Errors raised by the externalizer surface to the processor as
ordinary rejections; the processor wraps them in
`ExternalizationError` and records them on the publication's
`failureReason`.

### `@Externalized` decorator + `ExternalizationMetadata`

`@Externalized<TEvent>({ target, client?, routingKey?, headers? })`:

- `target` — broker-side destination (Kafka topic, RabbitMQ exchange,
  NATS subject, gRPC method). Required, non-empty string.
- `client` — DI token override for which `ClientProxy` to use, when
  more than one is registered.
- `routingKey: (event: TEvent) => string` — optional callback that
  derives a routing key from the event instance.
- `headers: Record<string, string> | (event) => Record<string, string>`
  — optional static or callback-derived headers.

`ExternalizationMetadata` is the resolved per-publication shape that
the externalizer receives at processor time: `routingKey` and dynamic
`headers` callbacks have already been invoked, so the externalizer
sees plain string values.

### `ExternalizationRegistry`

Indexes `@Externalized`-decorated event classes registered with
`EventTypeRegistry`. Built at module init by walking
`EventTypeRegistry.getAll()`. Provides:

- `has(eventType)`, `get(eventType)` — inspection.
- `buildMetadata(eventType, event)` — resolves the dynamic callbacks
  against an event instance and returns the
  `ExternalizationMetadata` to pass to the externalizer.

### `MicroservicesEventExternalizer` (in `outbox-microservices`)

The concrete `EventExternalizer` implementation. Resolves the bound
`ClientProxy` via `ModuleRef.get(token, { strict: false })` and calls
`firstValueFrom(client.emit(metadata.target, event))`. Failures from
proxy resolution OR the emit Observable are wrapped in
`ExternalizationError`.

Bootstrap validation (`validateOnBootstrap: true` by default) resolves
`defaultClient` once on `OnApplicationBootstrap` so a missing token
fails fast.

### `OutboxMicroservicesModule`

Wires `MicroservicesEventExternalizer` and binds it under
`EVENT_EXTERNALIZER` via `useExisting`, so the SPI token and the
concrete class point at the same singleton. Both `forRoot` and
`forRootAsync` are supported. The module does NOT register
`ClientProxy` instances itself — DD-017 requires the user's existing
`ClientsModule` registration.

## End-to-end sequence (success path)

```
User code   OutboxPublisher  Repo   Processor   ExtRegistry   Externalizer   ClientProxy   Broker
   │              │           │         │            │             │             │           │
   │ publish(e)   │           │         │            │             │             │           │
   ├─────────────►│           │         │            │             │             │           │
   │              │ register  │         │            │             │             │           │
   │              ├──────────►│         │            │             │             │           │
   │              │           │ row     │            │             │             │           │
   │              │           ├ insert ─┘            │             │             │           │
   │ (returns)    │           │ (PUBLISHED)          │             │             │           │
   │◄─────────────┤           │                      │             │             │           │
   │  ─ ─ ─ ─ ─ ─ tx commit ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─                                         │
   │              │           │                      │             │             │           │
   │              │           │      poll tick       │             │             │           │
   │              │           │◄─────────────────────┤             │             │           │
   │              │           │  findReadyForProcessing            │             │           │
   │              │           │                      │             │             │           │
   │              │           │  tryClaim (PROCESSING)             │             │           │
   │              │           │◄─────────────────────┤             │             │           │
   │              │           │                      │             │             │           │
   │              │           │      listener.invoke(event)        │             │           │
   │              │           │             ▼  (in-process)        │             │           │
   │              │           │      buildMetadata(typeName, event)│             │           │
   │              │           │           ─────────────────────────►             │           │
   │              │           │           ◄─ ExternalizationMetadata             │           │
   │              │           │      externalize(event, metadata) ▼              │           │
   │              │           │           ─────────────────────────────────────► │           │
   │              │           │           │                      client.emit(target, event)  │
   │              │           │           │                      ──────────────► │           │
   │              │           │           │                                       │ deliver  │
   │              │           │           │                                       ├─────────►│
   │              │           │           │                                       │◄─────────┤
   │              │           │           │                      ◄────────────── │ ack      │
   │              │           │           ◄─ resolved             │             │           │
   │              │           │      markCompleted (COMPLETED)                  │           │
   │              │           │◄────────────────────                              │           │
```

(The diagram is approximate; `firstValueFrom` is what actually
unwraps the Observable returned by `ClientProxy.emit` on the
externalizer side.)

The local listener runs first by design (DD-019): cheap, in-process
failures fail fast before the processor commits to a broker
round-trip. If the listener throws, the publication is recorded as
`FAILED` and the externalizer is never called — no partial delivery,
no orphan broker message that the local handler will never have run
behind.

## Failure modes (and the resulting publication state)

| Scenario                                     | publication state | externalizer called? |
|----------------------------------------------|-------------------|----------------------|
| Local listener throws                        | `FAILED`          | No                   |
| Local listener succeeds, no `@Externalized`  | `COMPLETED`       | No                   |
| Local listener succeeds, `@Externalized` mapping resolves, externalizer rejects | `FAILED` | Yes (rejected) |
| Local listener succeeds, externalizer succeeds and broker durably acked | `COMPLETED` | Yes |
| Local listener succeeds, externalizer succeeds but broker **silently dropped** the message | `COMPLETED` | Yes (resolved) |

The last row is the case **ADR-016** documents — see *Reliability
semantics* below.

## Reliability semantics

ADR-016 is the canonical reference; the summary here exists so
readers do not have to navigate away to understand the trade-off.

`@nestjs/microservices` `ClientProxy.emit()` follows the
fire-and-forget model: the Observable it returns completes when the
proxy considers the dispatch *handed off to the transport*, not
necessarily when the broker has *durably acknowledged* the message.
Different transports interpret "handed off" differently — Kafka with
default `acks: 'leader'` gets close to broker-acknowledged, RabbitMQ
in default mode does not — but in every case there are realistic
failure modes (broker unreachable, network partition during ack,
broker crash before fsync, configuration drift) where `emit()`
reports success and the message is never delivered.

`MicroservicesEventExternalizer` faithfully wraps that contract: an
Observable that completes without error becomes a resolved
`externalize()` Promise, the processor finalises the publication as
`COMPLETED`, and the outbox retry / staleness machinery does not
fire because there is nothing to detect from at this layer.

This is an architectural concern, not an implementation bug. Three
mitigation paths exist:

1. **Tighter `ClientProxy` configuration.** Kafka `producer.acks: 'all'`
   plus `producer.idempotent: true`. RabbitMQ confirm-channel via
   `amqp-connection-manager`. NATS JetStream with explicit ack. The
   externalizer reuses whatever proxy the user registered (DD-017),
   so this configuration applies transparently.
2. **Consumer-side acknowledgment / inbox patterns.** Track
   processed message ids on the receiving system and surface gaps
   to operators. The outbox publication's listener id plus the
   domain event id is enough to deduplicate.
3. **Broker-aware native externalizers** under the same
   `EVENT_EXTERNALIZER` SPI (DD-018). These would issue real
   round-trip acknowledgments and propagate broker errors back
   through the existing FAILED → `FailedEventPublications.resubmit`
   path. They are not yet scheduled but are the long-term answer
   for stricter delivery guarantees.

## Spring Modulith mapping

Migration from Spring Modulith should be largely mechanical at the
event-class layer:

| Spring Modulith                                   | Here                                                                  |
|---------------------------------------------------|-----------------------------------------------------------------------|
| `@Externalized("kafka::orders.placed")`           | `@Externalized({ target: 'orders.placed' })`                          |
| `@Externalized("amqp::exchange.events::#{tenant}")` | `@Externalized({ target: 'exchange.events', routingKey: (e) => e.tenantId })` |
| `EventExternalizer` (Spring's interface)          | `EventExternalizer` (`outbox`)                                   |
| `EventExternalizationConfiguration` builder       | `OutboxMicroservicesModule.forRoot` + per-event `@Externalized`       |
| `spring-modulith-events-kafka` artefact           | one transport of `outbox-microservices`                               |
| `spring-modulith-events-amqp` artefact            | one transport of `outbox-microservices`                               |
| `spring-modulith-events-jms` artefact             | one transport of `outbox-microservices`                               |
| `spring-modulith-events-messaging` artefact       | one transport of `outbox-microservices`                               |
| Spring SpEL routing-key expression                | Function-based `routingKey: (event) => ...`                           |
| Spring router/filter combinators                  | Compose plain functions in user code on the `routingKey` / `headers` callbacks |

The Java classpath ergonomics that drove Spring Modulith's per-broker
artefact split do not apply to the NestJS world; the
`@nestjs/microservices` `ClientProxy` abstraction lets a single
package serve every transport.

## Limitations

In addition to the reliability semantics covered above:

- **Headers and `routingKey` are accepted on `@Externalized` but not
  yet applied to the wire payload.** `@nestjs/microservices`
  `ClientProxy.emit` has no unified headers / routing-key parameter;
  per-transport handling differs (Kafka headers, AMQP properties,
  NATS subject suffixes, gRPC metadata). The first version logs the
  resolved values at debug level and continues; the broker-aware
  message-construction iteration ships in a later release. Wrap the
  event in a transport-specific envelope inside your own code if
  you need them now.

- **Multiple-client failover and per-event broker selection.** The
  module supports a `defaultClient` plus per-event override; cross-
  broker fallback (try Kafka, fall back to AMQP) is out of scope and
  would conflict with the single-unit atomicity contract from
  DD-019.

- **Schema evolution.** `outbox`'s `EventTypeRegistry` is the
  canonical source of truth for event class identity; renaming an
  `@Externalized` event class without supplying a stable id breaks
  the listener id encoding. Externalization itself does not add new
  schema-evolution constraints, but the existing ones still apply.

## References

- [ADR-015](../adr/015-event-externalization-architecture.md) — design rationale.
- [ADR-016](../adr/016-externalization-reliability-semantics.md) — reliability semantics, mitigations, future work.
- `packages/outbox/src/externalization/` — SPI, decorator, registry, errors.
- `packages/outbox-microservices/` — `ClientProxy`-backed externalizer + module.
- [`docs/architecture/outbox-pattern.md`](outbox-pattern.md) — outbox foundations this layer builds on.
- [`docs/architecture/outbox-integration-with-cqrs.md`](outbox-integration-with-cqrs.md) — `@nestjs/cqrs` interplay (in-memory + outbox routing).
