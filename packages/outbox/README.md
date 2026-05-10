# @nestjs-transactional/outbox

Persistent Event Publication Registry for NestJS — an ORM-agnostic core
that brings Spring Modulith-equivalent delivery guarantees to the
`@nestjs-transactional` family of packages.

## Overview

`@TransactionalEventsHandler` from `@nestjs-transactional/cqrs` provides
phase-based dispatching (like Spring Framework core): handlers fire
`AFTER_COMMIT`, `BEFORE_COMMIT`, `AFTER_ROLLBACK`, or `AFTER_COMPLETION`.
That covers a lot, but it is purely in-memory — if the process dies
between commit and handler invocation, the event is lost.

`outbox` closes that gap. It gives you:

- A persistent **Event Publication Registry** — every handler
  invocation is logged atomically with the business transaction.
- **Retry on process restart** — publications that were not acknowledged
  before shutdown are replayed on next startup.
- **Lifecycle states**: `PUBLISHED`, `PROCESSING`, `COMPLETED`, `FAILED`,
  `RESUBMITTED`.
- **Staleness monitor** — detects publications stuck in `PROCESSING`.
- **Failed / Incomplete / Completed** query APIs for operators.
- **Completion modes**: `UPDATE`, `DELETE`, `ARCHIVE`.

This package only defines types, the repository SPI, the in-memory
reference implementation (for tests), and the Nest module wiring. It
does **not** ship a production persistence backend — that lives in a
sibling package such as `@nestjs-transactional/outbox-typeorm`.

## Installation

```bash
pnpm add @nestjs-transactional/core @nestjs-transactional/outbox
# plus a persistence backend, e.g.:
pnpm add @nestjs-transactional/outbox-typeorm
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `reflect-metadata`,
`rxjs`.

## Usage

### 1. Module wiring

`OutboxModule.forRoot()` provides global infrastructure (registry,
serializer, processor, recovery). `OutboxModule.forFeature([...])`
declares the event classes a feature module owns — matches
`TypeOrmModule.forFeature(...)` ergonomics.

```typescript
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';

@Module({
  imports: [
    // isGlobal: true is REQUIRED so outbox providers can see
    // TransactionManager across module boundaries.
    TransactionalModule.forRoot({
      isGlobal: true,
      adapters: [/* your adapter registrations */],
    }),
    OutboxModule.forRoot({
      republishOnStartup: true,
      processor: { pollingInterval: 1000, batchSize: 100 },
      staleness: { processing: 60_000, monitorInterval: 30_000 },
      // repository: { provide: EVENT_PUBLICATION_REPOSITORY, useClass: TypeOrmEventPublicationRepository },
    }),
    // Import OutboxProcessingModule ONLY in worker processes — not in
    // API-only apps that merely publish events.
    OutboxProcessingModule,
    // Register the event classes this module emits / consumes.
    OutboxModule.forFeature([OrderPlacedEvent, OrderShippedEvent]),
  ],
})
export class AppModule {}
```

#### Modular pattern (multiple feature modules)

Distribute event registrations to the modules that own them:

```typescript
@Module({
  imports: [OutboxModule.forFeature([OrderPlacedEvent, OrderCancelledEvent])],
  providers: [OrderService],
})
export class OrderModule {}

@Module({
  imports: [OutboxModule.forFeature([InventoryReservedEvent])],
  providers: [InventoryService],
})
export class InventoryModule {}

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true /* ... */ }),
    OutboxModule.forRoot({ republishOnStartup: true /* ... */ }),
    OrderModule,
    InventoryModule,
  ],
})
export class AppModule {}
```

Multiple `forFeature` calls accumulate into the singleton
`EventTypeRegistry` provided by `forRoot`. Each event class can only
be registered once — duplicates throw at bootstrap with the offending
class name:

```
Error: Event type 'OrderPlacedEvent' already registered.
Each event type can only be registered once — check for duplicate
entries across OutboxModule.forFeature() calls.
```

`OutboxModule.forFeature([])` is accepted as a no-op (matches
`TypeOrmModule.forFeature([])`).

### 2. Declaring a handler

```typescript
import { Injectable } from '@nestjs/common';
import {
  type IOutboxEventHandler,
  OutboxEventsHandler,
} from '@nestjs-transactional/outbox';

@Injectable()
@OutboxEventsHandler(OrderPlacedEvent)
export class InventoryReservationHandler
  implements IOutboxEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    // Runs inside a fresh REQUIRES_NEW transaction, only after the
    // publishing transaction has committed. Retried on exception,
    // resumable across restarts.
  }
}
```

The decorator accepts either rest params or an options object:

```typescript
// Short form — defaults (newTransaction: true).
@OutboxEventsHandler(OrderPlacedEvent, OrderCancelledEvent)

// Long form — explicit options.
@OutboxEventsHandler({
  events: [OrderPlacedEvent],
  id: 'inventory.reservation',  // stable base id, see "Listener ids" below
  newTransaction: false,        // skip the REQUIRES_NEW wrapper
})
```

See ADR-014 for the rationale behind the class-level shape.

### 3. Publishing events

```typescript
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';

@Injectable()
export class PlaceOrderHandler {
  constructor(private readonly outbox: OutboxEventPublisher) {}

  @Transactional()
  async handle(command: PlaceOrder): Promise<void> {
    // ...persist business data in the same transaction...
    await this.outbox.publish(new OrderPlacedEvent(command.orderId));
  }
}
```

### 4. Operator APIs

```typescript
const failed = await this.failedEventPublications.findAll();
await this.failedEventPublications.resubmit(
  ResubmissionOptions.defaults().withBatchSize(50).withMaxAttempts(3),
);
await this.completedEventPublications.purge(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
```

## Listener ids

Every stored publication carries a `listenerId` string that identifies
which handler class should deliver it. The scanner composes the id as:

```
${baseId}#${EventName}
```

- **No explicit `id`**: baseId is the class name. Example:
  `InventoryReservationHandler#OrderPlacedEvent`.
- **With `options.id`**: baseId is the supplied string. Example:
  `inventory.reservation#OrderPlacedEvent`.

A class that handles multiple event types produces one id per event.
Renaming the class without supplying an explicit `id` breaks delivery
for every stored publication under the old id — set `options.id` when
you want stability across renames.

## Externalization (advanced)

> **Status:** SPI shipped (Phase 11.1–11.2). The
> `@nestjs/microservices` `ClientProxy`-backed `EventExternalizer`
> implementation ships as a separate package —
> [`@nestjs-transactional/outbox-microservices`](../outbox-microservices)
> (Phase 11.3). Without an externalizer bound, `@Externalized`
> mappings are recorded but never delivered to a broker — local
> outbox listeners still run.
>
> Architecture and design rationale:
> [ADR-015](../../docs/adr/015-event-externalization-architecture.md),
> [`docs/architecture/event-externalization.md`](../../docs/architecture/event-externalization.md).
> Reliability caveat for the `@nestjs/microservices`-backed
> implementation:
> [ADR-016](../../docs/adr/016-externalization-reliability-semantics.md).

`@Externalized` marks an event class for delivery to an external
message broker (Kafka topic, RabbitMQ exchange, NATS subject, ...) in
addition to local outbox listeners. The processor invokes the bound
`EventExternalizer` AFTER the local listener has succeeded — single
unit atomicity (DD-019): if either step fails, the publication is
recorded as `FAILED` and can be resubmitted via `FailedEventPublications`.

```typescript
import { Externalized } from '@nestjs-transactional/outbox';

@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',                       // broker-side destination
  routingKey: (e) => e.tenantId,                 // optional, brokers that support it
  headers: (e) => ({ 'x-tenant': e.tenantId }),  // static record OR callback
  client: 'KAFKA_CLIENT',                        // optional ClientProxy token
})
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly tenantId: string,
  ) {}
}
```

Bind a concrete externalizer under the `EVENT_EXTERNALIZER` token —
this is normally done by an extension package (`outbox-microservices`).
Custom implementations can register the same way:

```typescript
import { EVENT_EXTERNALIZER, type EventExternalizer } from '@nestjs-transactional/outbox';

@Module({
  providers: [
    {
      provide: EVENT_EXTERNALIZER,
      useClass: MyCustomExternalizer, // implements EventExternalizer
    },
  ],
})
export class MyAppModule {}
```

The processor only invokes the externalizer when BOTH a binding under
`EVENT_EXTERNALIZER` exists AND the event class carries an
`@Externalized` mapping — keep one without the other if you only need
half the contract (e.g. metadata-only mappings during a rollout, or a
generic externalizer that resolves targets some other way). Inspect
the resolved mapping at runtime via `ExternalizationRegistry`:

```typescript
import { ExternalizationRegistry } from '@nestjs-transactional/outbox';

@Injectable()
export class MyDiagnostics {
  constructor(private readonly externalization: ExternalizationRegistry) {}

  isExternalized(typeName: string): boolean {
    return this.externalization.has(typeName);
  }
}
```

Errors raised by the externalizer are wrapped in `ExternalizationError`
(carrying `eventType`, `target`, and the underlying cause) and surface
on the publication's `failureReason` for operator visibility.

## Testing utilities

Exported via the `/testing` subpath for assertions about which events
the code under test published. Mirrors Spring Modulith's
`PublishedEvents` / `AssertablePublishedEvents`.

```typescript
import {
  PublishedEvents,
  AssertablePublishedEvents,
} from '@nestjs-transactional/outbox/testing';

describe('PlaceOrder', () => {
  let app: TestingModule;
  let assertablePublishedEvents: AssertablePublishedEvents;

  beforeEach(async () => {
    app = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({ isGlobal: true /* ... */ }),
        OutboxModule.forRoot({}),
        OutboxModule.forFeature([OrderPlacedEvent]),
      ],
      providers: [
        PlaceOrderService,
        PublishedEvents,
        AssertablePublishedEvents,
      ],
    }).compile();
    await app.init();
    assertablePublishedEvents = app.get(AssertablePublishedEvents);
  });

  it('publishes OrderPlacedEvent for the placed order', async () => {
    const service = app.get(PlaceOrderService);
    await service.place('order-123');

    const view = await assertablePublishedEvents.contains(OrderPlacedEvent);
    view.matching((e) => e.orderId, 'order-123').hasSize(1);
  });

  it('publishes nothing when validation rejects the command', async () => {
    const service = app.get(PlaceOrderService);
    await service.placeInvalid().catch(() => undefined);

    await assertablePublishedEvents.doesNotContain(OrderPlacedEvent);
  });
});
```

`PublishedEvents.ofType(EventType)` returns a fluent `PublishedEventsView`
for read-only inspection (`.get()`, `.count()`,
`.matching(predicate)`, `.matching(getter, expected)`).
`AssertablePublishedEvents.contains(EventType)` is the assertion-first
counterpart — it throws `PublishedEventsAssertionError` when zero
events match, and returns an `AssertionView` whose `.matching(...)`
and `.hasSize(...)` operate synchronously over the already-fetched
events.

The utilities read through the wired `EventPublicationRepository`
implementation, so the default `InMemoryEventPublicationRepository`
works out of the box for unit-level tests. Integration tests that use
`@nestjs-transactional/outbox-typeorm` with a real Postgres get the
same API for free.

## Worked examples

- [`basic-outbox`](../../examples/basic-outbox) — `@OutboxEventsHandler` + `OutboxEventPublisher`, in-memory test repository.
- [`basic-typeorm-outbox`](../../examples/basic-typeorm-outbox) — production-shape outbox with Postgres, atomicity proven via testcontainers.
- [`multi-datasource-outbox`](../../examples/multi-datasource-outbox) — per-DS `event_publication` tables (ADR-019 multi-`forRoot`).
- [`shared-database-modular-monolith`](../../examples/shared-database-modular-monolith) — one Postgres, multi-schema, per-module outbox stacks.
- [`saga-pattern`](../../examples/saga-pattern) — choreographed multi-step business saga over outbox events.
- [`audit-logging`](../../examples/audit-logging) — cross-DS audit trail with idempotency on the consumer.
- [`e-commerce-orders`](../../examples/e-commerce-orders) — three-bounded-context flagship wired through outbox integration events.

Full catalogue: [examples/README.md](../../examples/README.md).

## Status

**Alpha / in development.** Public API not yet stable and may change
between 0.x releases. Current functionality is exercised end-to-end
through the Phase 14.8 worked-example library — see
[`examples/README.md`](../../examples/README.md).

Phase history and design notes:
[`docs/roadmap/README.md`](../../docs/roadmap/README.md),
[`docs/adr/006-outbox-pattern.md`](../../docs/adr/006-outbox-pattern.md).

## Inspired by Spring Modulith

The design follows
[Spring Modulith's Event Publication Registry](https://docs.spring.io/spring-modulith/reference/events.html)
closely — lifecycle states, `@ApplicationModuleListener` semantics,
completion modes, and staleness monitoring all map one-to-one. The
deviations from Spring Modulith are limited to what is needed to fit
the Node.js / NestJS runtime (async workers instead of thread pools,
AsyncLocalStorage for transaction context, NestJS DI conventions,
class-level handler decorators aligned with `@nestjs/cqrs`
conventions — see ADR-014).

## License

MIT
