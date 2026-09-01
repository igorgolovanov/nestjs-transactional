# Event externalization

> **TL;DR.** `@Externalized` marks an event for delivery to a message
> broker. After the local outbox listener completes successfully, the
> bound `EventExternalizer` is invoked with resolved metadata and
> sends the event over `@nestjs/microservices` `ClientProxy`. The
> outbox publication transitions to `COMPLETED` only when both steps
> resolve. What that proves about broker delivery depends on the
> transport, and the per-transport table is in
> [ADR-021](../adr/021-externalization-acknowledgement-per-transport.md).

This document expands [ADR-015](../adr/015-event-externalization-architecture.md)
with diagrams, concrete component descriptions, the end-to-end
sequence, the Spring Modulith mapping, and a delivery guarantee
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
│    ├── tryExternalize(event, publication)     (externalization)    │
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

Whether the last row is reachable depends on the transport. On Kafka
and RabbitMQ it takes a broker that acknowledges and then loses the
message before durable storage, or a configuration that gave the
acknowledgement away. On core NATS and TCP it is the normal case,
because nothing is acknowledged at all. See below.

## Delivery guarantee

[ADR-021](../adr/021-externalization-acknowledgement-per-transport.md)
is the canonical reference, with the measurements and the reading of
each client's `dispatchEvent`. The summary here exists so readers do
not have to navigate away.

`ClientProxy.emit()` does not mean the same thing on every transport:

| Transport | `emit()` resolves when | Acknowledged by the broker? |
| --- | --- | --- |
| Kafka | `producer.send()` settles; `kafkajs` defaults to `acks: -1` | Yes |
| RabbitMQ | the publisher confirm arrives (`amqp-connection-manager` defaults `confirm` to `true`) | Yes, but `persistent` defaults to `false` |
| MQTT | PUBACK at QoS 1 and above, immediately at QoS 0 | Depends on QoS |
| Redis | the `PUBLISH` command replies | Server received it; pub/sub does not persist |
| TCP | the message is written to the socket | No |
| NATS | immediately: core `publish()` returns `void` | No |
| gRPC | never: `dispatchEvent` throws | Not usable for externalization |

`MicroservicesEventExternalizer` wraps whichever of those it is given:
an Observable that completes without error becomes a resolved
`externalize()` Promise and a `COMPLETED` publication, and a rejection
becomes `FAILED` with a readable reason. On Kafka and RabbitMQ that
means an unreachable broker feeds straight into the retry, staleness
and `FailedEventPublications.resubmit` machinery. On NATS it means
nothing ever will.

What is worth doing about it:

1. **Do not configure the acknowledgement away.** Kafka `acks: 0`,
   MQTT QoS 0, and RabbitMQ without `persistent: true` each give up a
   guarantee the defaults provide. `producer.idempotent: true` on
   Kafka additionally protects against duplicates from producer
   retries. The externalizer reuses whatever proxy the user
   registered (DD-017), so all of this applies transparently.
2. **Consumer-side acknowledgment / inbox patterns.** At-least-once
   means duplicates are expected. Track processed message ids on the
   receiving system and surface gaps to operators. The outbox
   publication's listener id plus the domain event id is enough to
   deduplicate.
3. **A different externalizer where the transport cannot help.** The
   `EVENT_EXTERNALIZER` SPI (DD-018) is public, so a NATS
   implementation built on JetStream's `PubAck` slots into the same
   place without client-code changes. Kafka and RabbitMQ do not need
   one.

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

In addition to the per-transport delivery guarantee covered above:

- **gRPC cannot be used as an externalization transport.**
  `ClientGrpcProxy.dispatchEvent` throws
  `Method is not supported in gRPC mode` unconditionally, so an
  `@Externalized` event routed to a gRPC client has never been
  publishable.

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
- [ADR-021](../adr/021-externalization-acknowledgement-per-transport.md) — what `emit()` acknowledges per transport, measured.
- [ADR-016](../adr/016-externalization-reliability-semantics.md) — the superseded reliability claim, kept for the reasoning that led to it.
- `packages/outbox/src/externalization/` — SPI, decorator, registry, errors.
- `packages/outbox-microservices/` — `ClientProxy`-backed externalizer + module.
- [`docs/architecture/outbox-pattern.md`](outbox-pattern.md) — outbox foundations this layer builds on.
- [`docs/architecture/outbox-integration-with-cqrs.md`](outbox-integration-with-cqrs.md) — `@nestjs/cqrs` interplay (in-memory + outbox routing).
