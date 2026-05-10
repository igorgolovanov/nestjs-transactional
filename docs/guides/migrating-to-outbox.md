# Migrating from `@TransactionalEventsHandler` to the outbox

This guide walks through upgrading an application that today
relies on `@nestjs-transactional/cqrs`'s in-memory
`@TransactionalEventsHandler` to the durable outbox-backed
delivery path (`@nestjs-transactional/outbox` plus a backend
package such as `@nestjs-transactional/outbox-typeorm`).

No behavioural breaking changes — every existing
`@TransactionalEventsHandler` keeps working as before. The
migration is opt-in per handler class, and in most cases requires
one decorator change plus a one-time module wiring update.

The end-to-end runnable references for this guide are
[`examples/basic-typeorm-outbox`](../../examples/basic-typeorm-outbox/)
(single-DataSource baseline) and
[`examples/e-commerce-orders`](../../examples/e-commerce-orders/)
(multi-DataSource flagship with CQRS aggregates and Kafka
externalization).

## What you get after the migration

- **Durable delivery** — publications survive process crashes and
  deploys. A handler that was "in the middle of running" is
  resumed on next startup.
- **Operator-facing retry** — failed publications are queryable
  and resubmittable via `FailedEventPublications.resubmit(...)`.
- **Staleness monitoring** — publications stuck in `PROCESSING`
  (worker died mid-flight) flip back to `FAILED` for another
  attempt.
- **Horizontal scale-out** — multiple worker processes poll the
  same table without fighting each other (`FOR UPDATE SKIP LOCKED`).
- **At-least-once delivery semantics** — publications commit
  atomically with the business write. A committed publication is
  guaranteed to be delivered; a publication whose transaction
  rolled back never exists.
- **Optional externalization** — once the outbox is in place,
  layering Kafka / RabbitMQ / NATS delivery via
  `@nestjs-transactional/outbox-microservices` is one decorator
  (`@Externalized`) plus one module import. See
  [Adding externalization](#adding-externalization-to-a-message-broker)
  below.

## What stays the same

- Your `@Transactional()` methods.
- Your `@nestjs/cqrs` command / query handlers and aggregates
  (`AggregateRoot.apply(...)`, `commit()`).
- Any `@TransactionalEventsHandler` you leave untouched. It keeps
  running in-memory, at its current phase, exactly as before.
- Your `@nestjs/typeorm` `@InjectRepository` injection points —
  Phase 14.20 transparent transactional repositories make them
  dispatch through the active `@Transactional()` scope
  automatically. No `getCurrentEntityManager()` calls in service
  code.

## Step 1 — install the packages

```bash
pnpm add @nestjs-transactional/outbox \
         @nestjs-transactional/outbox-typeorm
```

(Or use your backend of choice when more arrive.)

## Step 2 — register the entities with your DataSource

The outbox-typeorm package ships two entities: the hot
`EventPublicationEntity` and the `EventPublicationArchiveEntity`.
Add both to your `DataSource`'s `entities` array:

```ts
import {
  EventPublicationEntity,
  EventPublicationArchiveEntity,
} from '@nestjs-transactional/outbox-typeorm';

TypeOrmModule.forRoot({
  type: 'postgres',
  // ...existing options...
  entities: [
    EventPublicationEntity,
    EventPublicationArchiveEntity,
    // ...your own entities...
  ],
}),
```

## Step 3 — apply the schema

Two options:

### 3a — Production (preferred): run the migration

```ts
import { CreateEventPublication1700000000000 } from '@nestjs-transactional/outbox-typeorm';

export const dataSource = new DataSource({
  // ...
  migrations: [CreateEventPublication1700000000000, /* ...your own */],
});
```

Then run your normal migration workflow:

```bash
pnpm typeorm migration:run -d ./dist/data-source.js
```

The timestamp `1700000000000` is a placeholder chosen to sort
before most application-owned migrations. Feel free to copy the
migration file into your own tree and rename it to match your
team's timestamp convention.

### 3b — Development: auto-initialise at bootstrap

For local development or test containers, you can skip the
migration and let `SchemaInitializer` create the tables on first
boot:

```ts
OutboxTypeOrmModule.forRoot({
  schemaInitialization: { enabled: process.env.NODE_ENV !== 'production' },
}),
```

Do NOT enable this in production — schema changes should go
through a reviewed migration.

## Step 4 — wire the modules

Add the outbox modules to your root module. The single-DataSource
shape:

```ts
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  OutboxEventPublisher,
  OutboxListenerRegistry,
  OutboxModule,
  OutboxProcessingModule,
} from '@nestjs-transactional/outbox';
import {
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';
import {
  CqrsTransactionalModule,
  OUTBOX_LISTENER_REGISTRAR,
  OUTBOX_PUBLICATION_SCHEDULER,
} from '@nestjs-transactional/cqrs';

@Module({
  imports: [
    // ----- TypeORM (your existing config) -----
    TypeOrmModule.forRoot({ /* ... */ }),
    TypeOrmModule.forFeature([/* your entities */]),

    // ----- Process-wide transactional infrastructure -----
    TransactionalModule.forRoot({ isGlobal: true }),                  // already there
    TypeOrmTransactionalModule.forRoot(),                             // already there

    // ----- Outbox stack (NEW) -----
    OutboxTypeOrmModule.forRoot({
      schemaInitialization: { enabled: process.env.NODE_ENV !== 'production' },
    }),

    OutboxModule.forRoot({
      repository: typeOrmEventPublicationRepositoryProvider(),        // IMPORTANT
      republishOnStartup: true,
      processor: { pollingInterval: 1000, batchSize: 100 },
      staleness: { processing: 60_000, monitorInterval: 30_000 },
    }),

    // Register the event classes the outbox should know about.
    // In modular apps each feature module imports forFeature() for
    // the events it owns; this snippet collapses them for clarity.
    OutboxModule.forFeature([OrderPlacedEvent /* , ... */]),

    // Only in worker processes — not in API-only apps that merely publish.
    OutboxProcessingModule,

    // ----- CQRS bridge (only if you use @nestjs/cqrs) -----
    CqrsTransactionalModule.forRoot(),                                // already there
  ],
  providers: [
    // Routes AggregateRoot.commit() events to the outbox for durable
    // publication.
    { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
    // Routes @IntegrationEventsHandler classes to the outbox registry
    // for durable delivery.
    { provide: OUTBOX_LISTENER_REGISTRAR, useExisting: OutboxListenerRegistry },
  ],
})
export class AppModule {}
```

Three details that bite first-timers:

1. **`repository: typeOrmEventPublicationRepositoryProvider()`** is
   the function call that returns a `useExisting` Provider. Without
   it, `OutboxModule` falls back to `InMemoryEventPublicationRepository`
   — the outbox runs but never actually writes to Postgres, so
   nothing survives a restart. Note the parentheses — passing the
   function reference without invoking it is a frequent typo
   (Convention #21 in [`docs/status/conventions.md`](../status/conventions.md)).

2. **The two `provide:` lines** wire the cqrs-side structural ports
   to outbox's concrete services. `OUTBOX_PUBLICATION_SCHEDULER`
   makes `HybridEventPublisher` route `AggregateRoot.commit()`
   events into the outbox; `OUTBOX_LISTENER_REGISTRAR` makes
   `IntegrationEventsHandlerScanner` route `@IntegrationEventsHandler`
   classes to the outbox instead of to the in-memory dispatcher.
   Omit either binding and that half of the integration falls back
   to in-memory.

3. **`OutboxProcessingModule`** auto-starts the per-DS processor
   and the staleness monitor on `OnApplicationBootstrap`. Import
   it in worker processes only; an API-only service that just
   publishes events should not own the processor.

Live reference: [`examples/basic-typeorm-outbox/src/app.module.ts`](../../examples/basic-typeorm-outbox/src/app.module.ts).

## Step 5 — pick a handler per use case

For each `@TransactionalEventsHandler` in your codebase, decide
what kind of delivery it needs.

### Keep `@TransactionalEventsHandler` when…

- …the handler is cheap, in-process, and idempotent on re-runs.
- …the side effect is safe to lose on a crash between commit and
  invocation. Examples: cache invalidation, metric counters,
  in-process logging.
- …the handler must run inside `BEFORE_COMMIT` (the outbox is
  always post-commit).

```ts
// Unchanged:
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
export class OrderPlacedMetrics
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  handle(event: OrderPlacedEvent): void {
    this.metrics.increment('orders.placed');
  }
}
```

### Replace with `@IntegrationEventsHandler` when…

- …the handler does cross-module or external-system work and
  at-least-once delivery matters. This covers the typical
  "send an email", "call an external API", "write to another
  bounded context" cases.

```ts
// Before:
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
export class SendConfirmationHandler
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    await this.emailer.send(event);
  }
}

// After:
@Injectable()
@IntegrationEventsHandler(OrderPlacedEvent)
export class SendConfirmationHandler
  implements IIntegrationEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    await this.emailer.send(event);
  }
}
```

The decorator and the marker interface are the only changes.
Semantics when the outbox registrar is bound: durable, retried
on failure, runs in a fresh `REQUIRES_NEW` transaction.
Semantics when the registrar is NOT bound: in-memory
`AFTER_COMMIT` with `async: true` in a fresh transaction — close
to the behaviour the `@TransactionalEventsHandler` gave you
before. So adding the decorator does not break anything in
staging or test environments that have not yet enabled the
outbox.

### Use `@OutboxEventsHandler` when…

- …you want the outbox explicitly, no in-memory fallback. The
  class will simply not be delivered if the outbox is not wired.
- …the class name might change and you need a stable `id` for
  the persistent registry to resolve across renames.

```ts
@Injectable()
@OutboxEventsHandler({
  events: [OrderPlacedEvent],
  id: 'Inventory.stable-id',
})
export class InventoryReservationHandler
  implements IOutboxEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    await this.inventory.reserve(event.orderId);
  }
}
```

## Step 6 — set up a worker process (optional)

`OutboxModule` by itself registers the outbox infrastructure but
does not start the async worker or the staleness monitor. For
those to run, import `OutboxProcessingModule` in the process that
should do the work:

- **Monolith** — import both `OutboxModule` and
  `OutboxProcessingModule` in your main app. Publishing and
  worker run side-by-side.
- **API + worker split** — import only `OutboxModule` in your
  API service; import BOTH in your worker service. The two
  share the same database.

The `OutboxProcessingModule` auto-starts the processor and the
staleness monitor on `OnApplicationBootstrap` and auto-stops
them on `OnApplicationShutdown` — no manual hooks required.

For graceful shutdown of in-flight publications during deploys,
see the user-side `OutboxDrainService` pattern in
[`examples/graceful-shutdown`](../../examples/graceful-shutdown/)
(Convention #24).

## Step 7 — test the migration

The outbox `/testing` subpath exposes `PublishedEvents` and
`AssertablePublishedEvents` for Spring-Modulith-style assertions:

```ts
import {
  PublishedEvents,
  AssertablePublishedEvents,
} from '@nestjs-transactional/outbox/testing';

// Register both as providers in your test module.
// Then in your test:

it('publishes OrderPlacedEvent for the placed order', async () => {
  await service.place('order-123');

  const view = await assertablePublishedEvents.contains(OrderPlacedEvent);
  view.matching((e) => e.orderId, 'order-123').hasSize(1);
});
```

Both helpers read through the wired `EventPublicationRepository`
implementation, so they work with the in-memory adapter for fast
unit tests AND with the TypeORM adapter for testcontainers
integration tests. See
[`examples/testing-patterns`](../../examples/testing-patterns/)
for the three-tier scaffold (unit / outbox unit / integration).

## Multi-DataSource migration

If your application runs multiple `DataSource`s (modular monolith,
audit-store split, ORM migration), each DS gets its own outbox
stack. Phase 14.3.1 + 14.21 made this transparent: handler
registration auto-routes to the owning DS, and per-DS event
publication tables don't contend.

Module wiring (mirrors the
[`examples/multi-datasource-outbox`](../../examples/multi-datasource-outbox/)
example):

```ts
@Module({
  imports: [
    // Two DataSources via @nestjs/typeorm.
    TypeOrmModule.forRoot({ name: 'default',   /* ... */ }),
    TypeOrmModule.forRoot({ name: 'inventory', /* ... */ }),

    // Process-wide infrastructure.
    TransactionalModule.forRoot({ isGlobal: true }),

    // Per-DS transactional adapters.
    TypeOrmTransactionalModule.forRoot({ isDefault: true }),
    TypeOrmTransactionalModule.forRoot({ dataSource: 'inventory' }),

    // Per-DS outbox-typeorm registrations (each call resolves the
    // DataSource via getDataSourceToken(name) and registers a
    // TypeOrmEventPublicationRepository under a per-DS private token).
    OutboxTypeOrmModule.forRoot({
      schemaInitialization: { enabled: process.env.NODE_ENV !== 'production' },
    }),
    OutboxTypeOrmModule.forRoot({
      dataSource: 'inventory',
      schemaInitialization: { enabled: process.env.NODE_ENV !== 'production' },
    }),

    // Per-DS outbox-core registrations.
    OutboxModule.forRoot({
      repository: typeOrmEventPublicationRepositoryProvider(),
      // ...processor / staleness options for the default DS...
    }),
    OutboxModule.forRoot({
      dataSource: 'inventory',
      repository: typeOrmEventPublicationRepositoryProvider('inventory'),
      // ...processor / staleness options for the inventory DS...
    }),

    // Per-DS event-class registrations.
    OutboxModule.forFeature([InvoiceCreatedEvent]),                       // default DS
    OutboxModule.forFeature([StockAdjustedEvent], { dataSource: 'inventory' }),

    // One worker module covers every per-DS processor.
    OutboxProcessingModule,
  ],
})
export class AppModule {}
```

Cross-DS coordination is **always** through the outbox — DD-023
forbids cross-DS atomic transactions. A handler that needs to
write to two DataSources should publish an integration event from
one and consume it on the other.

For the choreographed-saga shape (place order in DS A, react in
DS B with compensation), see
[`examples/saga-pattern`](../../examples/saga-pattern/) (single-DS
multi-step) and
[`examples/e-commerce-orders`](../../examples/e-commerce-orders/)
(three-DS flagship with the same pattern).

## Adding externalization to a message broker

Once the outbox is in place, delivering events to Kafka /
RabbitMQ / NATS / any `@nestjs/microservices` transport is a
small step. Two pieces:

### 1. Annotate the event class

```ts
import { Externalized } from '@nestjs-transactional/outbox';

@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  routingKey: (e) => e.tenantId,
  client: 'KAFKA_CLIENT',
})
export class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly tenantId: string,
  ) {}
}
```

### 2. Wire `outbox-microservices`

```ts
import { ClientsModule, Transport } from '@nestjs/microservices';
import { OutboxMicroservicesModule } from '@nestjs-transactional/outbox-microservices';

@Module({
  imports: [
    // ...your existing outbox stack...

    ClientsModule.register([
      {
        name: 'KAFKA_CLIENT',
        transport: Transport.KAFKA,
        options: { client: { brokers: ['localhost:9092'] } },
      },
    ]),

    OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA_CLIENT' }),
  ],
})
export class AppModule {}
```

The processor invokes the bound `EventExternalizer` AFTER the
local listener has succeeded — single-unit atomicity (DD-019):
if either step fails, the publication is recorded as `FAILED`
and surfaces in `FailedEventPublications.resubmit(...)`.

**Read [ADR-016](../adr/016-externalization-reliability-semantics.md)
before going to production**: the `@nestjs/microservices` `ClientProxy.emit()`
API does NOT propagate broker-side delivery failures. Mitigation
strategies (idempotent producers, consumer-side inbox / dedup) are
covered in
[`examples/externalization-with-fallback`](../../examples/externalization-with-fallback/).

## Migrating from older snapshots

If you are coming from a pre-0.1.0 snapshot that had method-level
`@TransactionalEventsListener` / `@OutboxEventListener` /
`@ApplicationModuleListener` decorators, every occurrence must be
rewritten to the current class-level shape: lift the decorator to
the class, rename the method to `handle`, and implement the
matching `I*Handler` interface.

```ts
// Before (method-level, pre-0.1.0):
@Injectable()
class NotificationHandlers {
  @TransactionalEventsListener(OrderPlacedEvent)
  onOrderPlaced(event: OrderPlacedEvent): void { /* ... */ }
}

// After (class-level):
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
class OrderPlacedMetrics
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  handle(event: OrderPlacedEvent): void { /* ... */ }
}
```

[ADR-014](../adr/014-handler-api-redesign.md) covers the rationale
in full. **Listener id format**: stored publications written under
the old `${ClassName}.${methodName}` format will NOT be resolved
by the current `${baseId}#${EventName}` format. For a fresh
database (no stored publications) no cleanup is needed; for a
populated `event_publication` table, drain the queue under the
old version OR call `OutboxListenerRegistry.register(...)` at
bootstrap with the legacy id and a closure that re-dispatches to
the renamed class.

## Troubleshooting

**"My `@OutboxEventsHandler` never fires."**
Likely causes: (1) the `repository` option on
`OutboxModule.forRoot` is missing or passed without parentheses
— pointing at the InMemory default — no rows make it to Postgres;
(2) no worker is running — import `OutboxProcessingModule` in a
process; (3) the event type was not registered via
`OutboxModule.forFeature([...])` in any imported module —
deserialisation fails and the row stays in `FAILED`; (4) the
class lacks a `handle` method — the scanner logs a warning and
skips.

**"Event type 'X' already registered."**
The same event class appears in two `OutboxModule.forFeature([...])`
calls. Move the registration to a single feature module — the one
that actually owns the event class.

**"Rollback leaks a publication row."**
Should not happen — flush is a `beforeCommit` hook, and
`beforeCommit` hooks participate in the transaction. Verify your
adapter reports commit failures correctly. The
[atomicity regression spec](../../packages/outbox-typeorm/test/integration/atomicity.integration.spec.ts)
pins this contract end-to-end against real Postgres.

**"Two workers each grab the same row."**
Should not happen — `findReadyForProcessing` uses
`SELECT ... FOR UPDATE SKIP LOCKED` (Postgres) and `tryClaim`
uses a conditional `UPDATE ... WHERE status IN (...)`. If you
are running the worker on a database without `SKIP LOCKED`
support, you need a different backend adapter.

**"`@IntegrationEventsHandler` fires twice."**
Each class is routed to exactly one path by
`IntegrationEventsHandlerScanner`. If you see a double
invocation, verify you haven't registered the same class twice
under different module hierarchies, and that you don't have both
an `@IntegrationEventsHandler` and an `@OutboxEventsHandler` on
overlapping event types from separate classes (which would be
two deliveries, one per class — the intended behaviour).

**"Multi-DS handler fires on the wrong DataSource."**
Phase 14.3.1 Category B requires `@TransactionalEventsHandler`
classes to declare their owning DS via the decorator option:

```ts
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  dataSource: 'inventory',
})
```

Outbox-routed handlers (`@OutboxEventsHandler`,
`@IntegrationEventsHandler`) auto-route via the per-DS event-type
registry and need no explicit `dataSource` option (Category A).

**"Kafka externalizer reports success but no message arrives."**
ADR-016 silent-success limitation. The `@nestjs/microservices`
`ClientProxy.emit()` API completes when the dispatch is handed
off to the transport, not when the broker durably acknowledges.
Mitigation: configure the proxy for stronger acknowledgment
(Kafka `producer.acks: 'all'` + `idempotent: true`, RabbitMQ
confirm channels, NATS JetStream), or add a consumer-side
inbox / dedup check. See
[`examples/externalization-with-fallback`](../../examples/externalization-with-fallback/).

## See also

- [Outbox pattern overview](../architecture/outbox-pattern.md)
- [Outbox integration with CQRS](../architecture/outbox-integration-with-cqrs.md)
- [Event externalization architecture](../architecture/event-externalization.md)
- [ADR-006 — outbox rationale](../adr/006-outbox-pattern.md)
- [ADR-007 — outbox architecture](../adr/007-outbox-architecture.md)
- [ADR-014 — class-level handler API](../adr/014-handler-api-redesign.md)
- [ADR-015 — event externalization architecture](../adr/015-event-externalization-architecture.md)
- [ADR-016 — externalization reliability semantics](../adr/016-externalization-reliability-semantics.md)
- [ADR-018 — multi-adapter architecture](../adr/018-multi-adapter-architecture.md)
- [ADR-019 — `OutboxModule` multi-`forRoot` pattern](../adr/019-outbox-multi-forroot-pattern.md)
- [`examples/basic-typeorm-outbox`](../../examples/basic-typeorm-outbox/) — single-DS production-shape baseline.
- [`examples/multi-datasource-outbox`](../../examples/multi-datasource-outbox/) — two-DS independent outbox stacks.
- [`examples/saga-pattern`](../../examples/saga-pattern/) — choreographed multi-step business saga over outbox events.
- [`examples/e-commerce-orders`](../../examples/e-commerce-orders/) — three-DS flagship combining outbox + CQRS + REST + Kafka externalization.
