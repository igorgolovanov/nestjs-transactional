# @nestjs-transactional/outbox-microservices

> Spring Modulith `@Externalized` parity for NestJS — durable,
> retryable delivery of outbox events to external message brokers via
> the `@nestjs/microservices` `ClientProxy` abstraction.

`MicroservicesEventExternalizer` plugs into `@nestjs-transactional/outbox`
as the concrete `EventExternalizer` implementation and reuses the
existing `ClientsModule` registration in your application — one
package covers every transport `@nestjs/microservices` already
supports (Kafka, RabbitMQ, NATS, JMS, gRPC, custom).

## Architectural foundation

- [ADR-015 — event externalization architecture](../../docs/adr/015-event-externalization-architecture.md)
  explains the design (single-package strategy, structural-port SPI,
  reuse of `ClientsModule`, atomicity / ordering rules).
- [ADR-016 — externalization reliability semantics with `@nestjs/microservices`](../../docs/adr/016-externalization-reliability-semantics.md)
  documents the silent-success limitation that scopes what this
  package can guarantee out of the box, and the three production
  mitigation strategies.
- [`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md)
  has diagrams, the end-to-end sequence, the failure-mode table, and
  the Spring Modulith mapping.

### Spring Modulith mapping (at a glance)

This package is the NestJS analogue of Spring Modulith's
`@Externalized` plus its four broker-specific artefacts
(`spring-modulith-events-kafka`, `-amqp`, `-jms`, `-messaging`)
collapsed into one. `@Externalized` (in `outbox`) lifts directly
from Spring's annotation; the broker setup moves from a Spring
auto-configuration to the user's own `ClientsModule.register()`.
Function-based `routingKey` and `headers` callbacks replace SpEL
expressions; bring your own type system. Full table in the
architecture doc above.

## Status

**Alpha / in development.** Public API not yet stable and may change
between 0.x releases. Headers / `routingKey` are accepted on
`@Externalized` but not yet applied to the wire payload — see
*Limitations* below. End-to-end coverage lives in the Phase 14.8c
externalization tier examples and the Phase 14.8e flagship
[`e-commerce-orders`](../../examples/e-commerce-orders) — see
[Worked examples](#worked-examples).

## Important: reliability semantics (read before production use)

**Read this before adopting the package in production.** The
`@nestjs/microservices` `ClientProxy.emit()` API this package depends
on (per [DD-017](../../docs/dd/017-reuse-clients-module.md)) does NOT propagate broker-side
delivery failures in a way the externalizer can observe. In
fire-and-forget mode the Observable returned by `emit()` completes
when the proxy considers the dispatch *handed off to the transport*,
not when the broker has *durably acknowledged* the message.

Concretely, this means:

- A `ClientKafka` configured against an unreachable broker can resolve
  `emit()` successfully, the externalizer reports success, and the
  outbox publication is finalised as `COMPLETED` — even though no
  message ever reached a broker.
- The same applies to RabbitMQ in default fire-and-forget mode and to
  any other transport `@nestjs/microservices` supports.
- Silent broker failures bypass the outbox retry / staleness /
  resubmit machinery: there is nothing to retry, because as far as
  this layer is concerned delivery succeeded.

The outbox still gives you crash-consistent **enqueueing** of events
and at-least-once **local listener** delivery. What it does NOT give
you, in this version, is at-least-once **broker-side** delivery
through `ClientProxy`.

[ADR-016](../../docs/adr/016-externalization-reliability-semantics.md)
documents the finding in full and lays out the future path
(broker-aware externalizers using native producers under the same
`EVENT_EXTERNALIZER` SPI).
[ADR-015](../../docs/adr/015-event-externalization-architecture.md)
records why this trade-off is acceptable for the v1 scope —
[`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md)
has the full sequence diagram and the failure-mode table.

### Mitigation strategies for production

1. **Configure the underlying `ClientProxy` for stronger
   acknowledgment.** Kafka: `producer.acks: 'all'` plus
   `producer.idempotent: true`. RabbitMQ: confirm-channel via
   `amqp-connection-manager`. NATS: JetStream with explicit ack. The
   package reuses whatever proxy you registered (DD-017) — it does
   not interfere with this configuration.

2. **Combine with consumer-side acknowledgment / inbox patterns.**
   Track processed message ids on the receiving system and surface
   gaps to operators. The outbox publication's listener id plus the
   domain event id is enough to deduplicate.

3. **Wait for the broker-aware externalizer iteration** when neither
   of the above is feasible. The
   [`EVENT_EXTERNALIZER` SPI](../outbox/src/externalization/event-externalizer.ts)
   is stable; native adapters will plug into the same place without
   client-side changes.

## Installation

```bash
pnpm add @nestjs-transactional/outbox-microservices @nestjs-transactional/outbox @nestjs/microservices
```

`@nestjs-transactional/core`, `@nestjs/common`, `@nestjs/core`,
`reflect-metadata`, and `rxjs` are peer dependencies (already present
in any NestJS application).

## Prerequisites

This package does NOT register `ClientProxy` instances — that is your
job (DD-017). Configure them through the standard
`@nestjs/microservices` `ClientsModule`:

```typescript
import { ClientsModule, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: {
          client: { brokers: ['localhost:9092'] },
        },
      },
    ]),
  ],
})
export class AppModule {}
```

`OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA_CLIENT' })`
then resolves the same proxy via `ModuleRef.get(token, { strict: false })`
when an outbox publication is ready to be externalized — no parallel
connection pool, no second mental model.

## Basic example

```typescript
import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TransactionalModule } from '@nestjs-transactional/core';
import { Externalized, OutboxModule } from '@nestjs-transactional/outbox';
import { OutboxMicroservicesModule } from '@nestjs-transactional/outbox-microservices';

@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  routingKey: (e) => e.tenantId, // see Limitations — logged, not yet applied
})
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly tenantId: string,
  ) {}
}

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: { client: { brokers: ['localhost:9092'] } },
      },
    ]),
    OutboxModule.forRoot({}),
    OutboxModule.forFeature([OrderPlacedEvent]),
    OutboxMicroservicesModule.forRoot({
      defaultClient: 'KAFKA_CLIENT',
    }),
  ],
})
export class AppModule {}
```

When an `OrderPlacedEvent` flows through the outbox the local
listeners run first; once they succeed the externalizer calls
`KAFKA_CLIENT.emit('orders.placed', event)`. Failures (broker down,
client misconfigured, ...) mark the publication `FAILED` and surface
through `FailedEventPublications.resubmit()` — single-unit atomicity
per [DD-019](../../docs/dd/019-hybrid-delivery-atomicity.md).

## Multiple clients

Register every transport you need under distinct tokens, then point
each event at its broker via the `client` option on `@Externalized`:

```typescript
ClientsModule.register([
  { name: 'KAFKA_CLIENT', transport: Transport.KAFKA, options: { ... } },
  { name: 'AMQP_CLIENT',  transport: Transport.RMQ,   options: { ... } },
]),

@Externalized({ target: 'orders.placed', client: 'KAFKA_CLIENT' })
class OrderPlacedEvent { /* ... */ }

@Externalized({ target: 'audit', client: 'AMQP_CLIENT' })
class AuditableEvent { /* ... */ }
```

A `defaultClient` configured on the module is used when an event
omits the per-event `client`. Set neither and the externalizer
rejects the publication with a clear `ExternalizationError` — the row
is recorded as `FAILED` and the operator can fix the configuration
and resubmit.

## Multi-dataSource setups

This package needs no special configuration when the application
runs with multiple `OutboxModule.forRoot()` calls (one per
dataSource — ADR-019 multi-forRoot pattern). A single
`MicroservicesEventExternalizer` instance covers every dataSource;
per-DS processors all dispatch through it. Per-broker routing is
already handled by the per-event `client` parameter shown in
[*Multiple clients*](#multiple-clients) above — `@Externalized` is
dataSource-agnostic by design (an event class that lives in the
`'billing'` dataSource via `OutboxModule.forFeature([Event], { dataSource: 'billing' })`
still uses the same `client:` token resolution as a default-DS
event). See [`@nestjs-transactional/outbox` README](../outbox/README.md)
for the multi-`forRoot` pattern.

The module is registered as `@Global()` so the bound
`EVENT_EXTERNALIZER` is visible to `OutboxModule`'s sibling-imported
per-DS processors without an explicit import chain.

## Async configuration

For `defaultClient` that must be resolved from a `ConfigService`:

```typescript
OutboxMicroservicesModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    defaultClient: config.getOrThrow<string>('outbox.defaultClient'),
  }),
}),
```

## Bootstrap validation

By default the module resolves `defaultClient` once at
`OnApplicationBootstrap` and throws a descriptive error if the token
is unbound — the misconfiguration surfaces before the first event is
processed. Disable with `validateOnBootstrap: false` when the
`ClientProxy` registration is wired by an asynchronous factory that
finishes after the outbox bootstrap (the lookup is then deferred to
the first `externalize()` call).

## Limitations (Phase 11.3)

- **Headers and `routingKey` are accepted but not applied** to the
  wire payload yet. The `@nestjs/microservices` `ClientProxy.emit`
  API has no unified headers / routing-key parameter — handling is
  transport-specific (Kafka headers, AMQP properties, NATS subject
  suffixes, ...). For now the externalizer logs resolved values at
  debug level for visibility; the broker-aware message-construction
  iteration ships in a later release. Wrap the event in a
  transport-specific envelope inside your own code if you need them
  before then.
- **Real-broker integration tests** (Postgres + Kafka / RabbitMQ via
  testcontainers) ship with Phase 11.4 — the unit and module specs in
  this package use a mock `ClientProxy` and cover the SPI contract
  end-to-end without a live broker.

## Testing

The package's own tests use a mock `ClientProxy` directly. To exercise
the externalizer in your application's tests, register a stub provider
under your client's token before the module imports:

```typescript
const moduleRef = await Test.createTestingModule({
  imports: [
    /* ... ClientsModule.register([{ name: 'KAFKA_CLIENT', ... }]) */
    OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA_CLIENT' }),
  ],
})
  .overrideProvider('KAFKA_CLIENT')
  .useValue({ emit: jest.fn(() => of(undefined)) })
  .compile();
```

## Worked examples

- [`externalization-kafka`](../../examples/externalization-kafka) — single DataSource + single Kafka broker, the canonical Phase 11 baseline.
- [`externalization-multi-broker`](../../examples/externalization-multi-broker) — Kafka + RabbitMQ + Redis pub/sub routed per event via `@Externalized({ client })`.
- [`externalization-multi-datasource`](../../examples/externalization-multi-datasource) — two physical Postgres × two `ClientProxy` registrations on a single broker.
- [`externalization-with-fallback`](../../examples/externalization-with-fallback) — ADR-016 silent-success demo + the three production mitigation patterns + `FailedEventPublications.resubmit` recovery flow.
- [`e-commerce-orders`](../../examples/e-commerce-orders) — Phase 14.8e flagship; externalization is the terminal step of the order saga.

Full catalogue: [examples/README.md](../../examples/README.md).

## License

MIT — see [LICENSE](../../LICENSE).
