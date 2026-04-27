# Migrating from `@TransactionalEventsHandler` to the outbox

This guide walks through upgrading an application that today
relies on `@nestjs-transactional/cqrs`'s in-memory
`@TransactionalEventsHandler` to the durable outbox-backed
delivery path (`@nestjs-transactional/outbox` plus a
backend package such as `@nestjs-transactional/outbox-typeorm`).

No behavioural breaking changes — every existing
`@TransactionalEventsHandler` keeps working as before. The
migration is opt-in per handler class, and in most cases
requires one decorator change plus a one-time module wiring
update.

> **Coming from the pre-0.1.0 method-level decorators?** See the
> "Migrating from method-level listeners" section at the end —
> you need to move the method into `handle(event)` and lift the
> decorator up to the class before the rest of this guide
> applies.

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

## What stays the same

- Your `@Transactional()` methods.
- Your `@nestjs/cqrs` command / query handlers.
- Your aggregates (`AggregateRoot.apply(...)`, `commit()`).
- Any `@TransactionalEventsHandler` you leave untouched. It keeps
  running in-memory, at its current phase, exactly as before.

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

export const dataSource = new DataSource({
  type: 'postgres',
  // ...existing options...
  entities: [
    EventPublicationEntity,
    EventPublicationArchiveEntity,
    // ...your own entities...
  ],
});
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
OutboxTypeOrmModule.forFeature({
  dataSource,
  schemaInitialization: { enabled: process.env.NODE_ENV !== 'production' },
})
```

Do NOT enable this in production — schema changes should go
through a reviewed migration.

## Step 4 — wire the modules

Add three imports and two provider bindings to your root module:

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
    TransactionalModule.forRoot({ isGlobal: true }),               // already there
    TypeOrmTransactionalModule.forFeature({ dataSource }),         // already there

    OutboxTypeOrmModule.forFeature({ dataSource }),                // NEW
    OutboxModule.forRoot({
      repository: typeOrmEventPublicationRepositoryProvider,       // NEW — IMPORTANT
      republishOnStartup: true,                                    // optional
      processor: { pollingInterval: 1000, batchSize: 100 },         // optional
      staleness: { processing: 60_000, monitorInterval: 30_000 },   // optional
    }),

    // Register the event classes the outbox should know about.
    // In modular apps each feature module imports forFeature() for
    // its own events; this snippet collapses them for clarity.
    OutboxModule.forFeature([OrderPlacedEvent /* , ... */ ]),       // NEW

    // Only in worker processes — not in API-only apps that merely publish.
    OutboxProcessingModule,                                         // NEW

    CqrsTransactionalModule.forRoot(),                              // already there
  ],
  providers: [
    // NEW — routes AggregateRoot.commit() events to the outbox
    // for durable publication.
    { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
    // NEW — routes @IntegrationEventsHandler classes to the outbox
    // registry for durable delivery.
    { provide: OUTBOX_LISTENER_REGISTRAR, useExisting: OutboxListenerRegistry },
  ],
})
export class AppModule {}
```

The `repository: typeOrmEventPublicationRepositoryProvider` line
is the one most commonly forgotten. Without it, `OutboxModule`
installs its `InMemoryEventPublicationRepository` default — the
outbox runs but never actually writes to Postgres, so nothing
survives a restart. The aliasing Provider forwards the
`EVENT_PUBLICATION_REPOSITORY` token to the TypeORM
implementation provided by `OutboxTypeOrmModule`.

The two `provide:` lines wire the cqrs-side structural ports to
outbox's concrete services:

- `OUTBOX_PUBLICATION_SCHEDULER` makes `HybridEventPublisher`
  route `AggregateRoot.commit()` events into the outbox for
  durable publication.
- `OUTBOX_LISTENER_REGISTRAR` makes
  `IntegrationEventsHandlerScanner` route
  `@IntegrationEventsHandler` classes to the outbox instead of
  to the in-memory dispatcher.

Omit either binding and that half of the integration falls back
to in-memory.

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
@TransactionalEventsHandler(OrderPlacedEvent)
export class SendConfirmationHandler
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    await this.emailer.send(event);
  }
}

// After:
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

## Step 7 — test the migration

The outbox `/testing` subpath exposes
`PublishedEvents` and `AssertablePublishedEvents` for
Spring-Modulith-style assertions:

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

## Migrating from method-level listeners (pre-0.1.0 snapshots)

If you are coming from an earlier snapshot that had
`@TransactionalEventsListener`, `@OutboxEventListener`, or
`@ApplicationModuleListener` as **method-level** decorators,
every occurrence must be rewritten to the new class-level shape
before the rest of this guide applies. See ADR-014 for the
rationale.

**Mechanical conversion**:

```ts
// Before (method-level, pre-0.1.0):
@Injectable()
class NotificationHandlers {
  @TransactionalEventsListener(OrderPlacedEvent)
  onOrderPlaced(event: OrderPlacedEvent): void {
    this.metrics.increment('orders.placed');
  }

  @ApplicationModuleListener(OrderPlacedEvent)
  async shipOrder(event: OrderPlacedEvent): Promise<void> {
    await this.shipping.createShipment(event.orderId);
  }
}

// After (class-level):
@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
class OrderPlacedMetrics
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  handle(event: OrderPlacedEvent): void {
    this.metrics.increment('orders.placed');
  }
}

@Injectable()
@IntegrationEventsHandler(OrderPlacedEvent)
class ShipOrderHandler
  implements IIntegrationEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    await this.shipping.createShipment(event.orderId);
  }
}
```

Each method that previously carried a decorator becomes its own
class with that decorator at the class level, the method renamed
to `handle`, and the matching `I*Handler` interface
implemented. Register both new classes as providers (the module's
`providers` array or `@Module({ providers: [...] })`).

**Listener id change**: the new scanner composes listener ids as
`${baseId}#${EventName}` where baseId defaults to the class name
(or an explicit `options.id`). Stored publications written under
the old `${ClassName}.${methodName}` format will NOT be resolved
by the new scanners — they become orphans. Before re-running a
migrated application against a database with stored publications:

- **Maintenance-window option** — run the application's old
  version until the `event_publication` table is empty (or drop
  the outstanding rows if you can afford to), then deploy the
  new version.
- **Manual replay option** — for every orphaned `listenerId` you
  see in the database, call
  `OutboxListenerRegistry.register(...)` at bootstrap with a
  matching id and an `invoke` closure that re-dispatches to the
  renamed class.

For a fresh database (no stored publications) no cleanup is
needed.

## Breaking changes vs. previous snapshots

- **Pre-0.1.0 listener decorators removed**. See "Migrating from
  method-level listeners" above. No deprecation period — this is
  a pre-release shift.
- **Listener id format changed** from
  `${ClassName}.${methodName}` to `${baseId}#${EventName}`.
  Stored publications from the old format need manual cleanup or
  replay registration.

All other user-facing APIs — `@Transactional()`, propagation
modes, isolation levels, `AggregateRoot.commit()`,
`TransactionalEventPublisher` — are unchanged.

## Troubleshooting

**"My `@OutboxEventsHandler` never fires."**
Likely causes: (1) the `repository` option on
`OutboxModule.forRoot` is missing or pointing at the InMemory
default — no rows make it to Postgres; (2) no worker is running
— import `OutboxProcessingModule` in a process; (3) the event
type was not registered via `OutboxModule.forFeature([...])` in
any imported module — deserialisation fails and the row stays in
`FAILED`; (4) the class lacks a `handle` method — the scanner logs
a warning and skips.

**"Event type 'X' already registered."**
The same event class appears in two `OutboxModule.forFeature([...])`
calls. Move the registration to a single feature module — the one
that actually owns the event class.

**"Rollback leaks a publication row."**
Should not happen — flush is a `beforeCommit` hook, and
`beforeCommit` hooks participate in the transaction. Verify
your adapter reports commit failures correctly. The integration
test in `packages/outbox-typeorm/test/integration/cqrs-outbox.integration.spec.ts`
exercises this path.

**"Two workers each grab the same row."**
Should not happen — `findReadyForProcessing` uses
`SELECT ... FOR UPDATE SKIP LOCKED` (Postgres) and `tryClaim`
uses a conditional `UPDATE ... WHERE status IN (...)`. If you
are running the worker on a database without `SKIP LOCKED`
support, you need a different backend adapter.

**"`@IntegrationEventsHandler` fires twice."**
Shouldn't happen with the new scanner — each class is routed to
exactly one path. If you see a double invocation, verify you
haven't registered the same class twice under different module
hierarchies, and that you don't have both an
`@IntegrationEventsHandler` and an `@OutboxEventsHandler` on
overlapping event types from separate classes (which would be
two deliveries, one per class — the intended behaviour).

## See also

- [Outbox pattern overview](../architecture/outbox-pattern.md)
- [Outbox integration with CQRS](../architecture/outbox-integration-with-cqrs.md)
- [ADR-006 — outbox rationale](../adr/006-outbox-pattern.md)
- [ADR-007 — outbox architecture](../adr/007-outbox-architecture.md)
- [ADR-014 — class-level handler API redesign](../adr/014-handler-api-redesign.md)
- [`examples/outbox-full-stack/`](../../examples/outbox-full-stack/)
