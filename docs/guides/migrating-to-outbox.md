# Migrating from `@TransactionalEventsListener` to the outbox

This guide walks through upgrading an application that today
relies on `@nestjs-transactional/cqrs`'s in-memory
`@TransactionalEventsListener` to the durable outbox-backed
delivery path (`@nestjs-transactional/outbox-core` plus a
backend package such as `@nestjs-transactional/outbox-typeorm`).

No breaking changes — every existing `@TransactionalEventsListener`
keeps working as before. The migration is opt-in per listener,
and in most cases requires one decorator change plus a one-time
module wiring update.

## What you get after the migration

- **Durable delivery** — publications survive process crashes and
  deploys. A listener that was "in the middle of running" is
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
- Any `@TransactionalEventsListener` you leave untouched. It keeps
  running in-memory, at its current phase, exactly as before.

## Step 1 — install the packages

```bash
pnpm add @nestjs-transactional/outbox-core \
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

Add three entries to your root module, in this order:

```ts
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  OutboxModule,
  OutboxProcessingModule,
} from '@nestjs-transactional/outbox-core';
import {
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),               // already there
    TypeOrmTransactionalModule.forFeature({ dataSource }),         // already there

    OutboxTypeOrmModule.forFeature({ dataSource }),                // NEW
    OutboxModule.forRoot({
      eventTypes: [OrderPlacedEvent, /* ... */],                   // NEW
      repository: typeOrmEventPublicationRepositoryProvider,       // NEW — IMPORTANT
      republishOnStartup: true,                                    // optional
      processor: { pollingInterval: 1000, batchSize: 100 },         // optional
      staleness: { processing: 60_000, monitorInterval: 30_000 },   // optional
    }),

    // Only in worker processes — not in API-only apps that merely publish.
    OutboxProcessingModule,                                         // NEW
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

## Step 5 — pick a listener per use case

For each `@TransactionalEventsListener` in your codebase, decide
what kind of delivery it needs.

### Keep `@TransactionalEventsListener` when…

- …the listener is cheap, in-process, and idempotent on re-runs.
- …the side effect is safe to lose on a crash between commit and
  invocation. Examples: cache invalidation, metric counters,
  in-process logging.
- …the listener must run inside `BEFORE_COMMIT` (the outbox is
  always post-commit).

```ts
// Unchanged:
@TransactionalEventsListener(OrderPlacedEvent)
onOrderPlaced(event: OrderPlacedEvent): void {
  this.metrics.increment('orders.placed');
}
```

### Replace with `@ApplicationModuleListener` when…

- …the listener does cross-module or external-system work and
  at-least-once delivery matters. This covers the typical
  "send an email", "call an external API", "write to another
  bounded context" cases.

```ts
// Before:
@TransactionalEventsListener(OrderPlacedEvent)
async sendConfirmation(event: OrderPlacedEvent): Promise<void> {
  await this.emailer.send(event);
}

// After:
@ApplicationModuleListener(OrderPlacedEvent)
async sendConfirmation(event: OrderPlacedEvent): Promise<void> {
  await this.emailer.send(event);
}
```

The decorator is the only change. Semantics when the outbox is
wired: durable, retried on failure, runs in a fresh
`REQUIRES_NEW` transaction. Semantics when the outbox is NOT
wired: in-memory `AFTER_COMMIT` with `async: true` — same
behaviour the `@TransactionalEventsListener` gave you before. So
adding the decorator does not break anything in staging or test
environments that have not yet enabled the outbox.

### Use `@OutboxEventListener` when…

- …you want the outbox explicitly, no in-memory fallback.
- …the method name might change and you need a stable `id` for
  the persistent registry to resolve across renames.

```ts
@OutboxEventListener(OrderPlacedEvent, { id: 'Inventory.stable-id' })
async reserveStock(event: OrderPlacedEvent): Promise<void> {
  await this.inventory.reserve(event.orderId);
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

The outbox-core `/testing` subpath exposes
`PublishedEvents` and `AssertablePublishedEvents` for
Spring-Modulith-style assertions:

```ts
import {
  PublishedEvents,
  AssertablePublishedEvents,
} from '@nestjs-transactional/outbox-core/testing';

// Register both as providers in your test module.
// Then in your test:

it('publishes OrderPlacedEvent for the placed order', async () => {
  await service.place('order-123');

  const view = await assertablePublishedEvents.contains(OrderPlacedEvent);
  view.matching((e) => e.orderId, 'order-123').hasSize(1);
});
```

## Breaking changes

None. Every user-facing API shipped before Phase 5 continues to
work unchanged:

- `@Transactional()`, propagation modes, isolation levels.
- `@TransactionalEventsListener` — still in-memory, still
  phase-aware.
- `TransactionalEventPublisher` — still available as a
  standalone strategy. The adapter used by
  `CqrsTransactionalModule.forRoot()` changed to
  `HybridEventPublisher`, but the observable behaviour is
  identical when the outbox is NOT wired.

The only observable change for existing codebases is that the
`EventPublisher` DI override now resolves to an adapter built
around `HybridEventPublisher` instead of
`TransactionalEventPublisher`. Both implement `IEventPublisher`
identically; any code that consumed the adapter through the
`EventPublisher` token sees no difference.

## Troubleshooting

**"My `@OutboxEventListener` never fires."**
Likely causes: (1) the `repository` option on
`OutboxModule.forRoot` is missing or pointing at the InMemory
default — no rows make it to Postgres; (2) no worker is running
— import `OutboxProcessingModule` in a process; (3) the event
type was not registered in `OutboxModule.forRoot({ eventTypes: [...] })`
— deserialisation fails silently and the row stays in `FAILED`.

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

**"`@ApplicationModuleListener` fires twice."**
The in-memory scanner did not skip the method. Verify that
`OUTBOX_PUBLICATION_SCHEDULER` is bound — typically by a
`{ provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher }`
provider. `TransactionalListenerScanner` uses the presence of
this binding as its "outbox is wired" signal.

## See also

- [Outbox pattern overview](../architecture/outbox-pattern.md)
- [Outbox integration with CQRS](../architecture/outbox-integration-with-cqrs.md)
- [ADR-006 — rationale](../adr/006-outbox-pattern.md)
- [ADR-007 — architecture](../adr/007-outbox-architecture.md)
- [`examples/outbox-full-stack/`](../../examples/outbox-full-stack/)
