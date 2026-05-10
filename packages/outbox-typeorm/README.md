# @nestjs-transactional/outbox-typeorm

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox-typeorm/alpha?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox-typeorm)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

TypeORM persistence backend for
[`@nestjs-transactional/outbox`](../outbox). Ships the
`event_publication` table schema, a TypeORM-backed implementation of
the `EventPublicationRepository` SPI, and (in a later iteration) the
NestJS module wiring.

## Status

Alpha. Public API may change between 0.x releases. Current shape:

- `EventPublicationEntity` / `EventPublicationArchiveEntity` schema
  with all four indexes for worker / operator / cleanup paths.
- `TypeOrmEventPublicationRepository` integrates through the
  transparent transactional repository patches in
  [`@nestjs-transactional/typeorm`](../typeorm) — every read and
  write commits atomically with the business transaction.
- `OutboxTypeOrmModule.forRoot({ dataSource?, isDefault? })` and
  `forRootAsync({...})` — DataSource is resolved from DI via
  `@nestjs/typeorm`'s `getDataSourceToken(name)`, mirroring
  `TypeOrmTransactionalModule`.
- `SchemaInitializer` for development-time auto-init plus the
  shipped TypeORM migration `CreateEventPublication1700000000000`.

Design notes: [`docs/roadmap/README.md`](../../docs/roadmap/README.md),
[ADR-006](../../docs/adr/006-outbox-pattern.md),
[ADR-019](../../docs/adr/019-outbox-multi-forroot-pattern.md).

## What ships today

### Entities

- `EventPublicationEntity` (`event_publication`): the hot queue. Four
  indexes cover the worker, operator, and cleanup paths:
  - `(status, publicationDate)` — `findReadyForProcessing`,
    `findStale`.
  - `(status, listenerId)` — per-listener retries.
  - `(eventType)` — operator queries and event externalization.
  - `(completionDate)` — `findCompleted(olderThan)` and
    `deleteCompleted(olderThan)`.
  `status` is `varchar(32)` rather than a Postgres `enum`, to keep new
  lifecycle states from forcing a type migration.

- `EventPublicationArchiveEntity` (`event_publication_archive`): the
  cold audit trail used by the `ARCHIVE` completion mode. Same fields
  as `EventPublicationEntity` except `completionDate` is non-nullable
  — rows only arrive here after having completed.

### Repository

`TypeOrmEventPublicationRepository` implements
`EventPublicationRepository` from `outbox`. Highlights:

- Every read and write goes through the ambient
  `EntityManager` resolved by
  `@nestjs-transactional/typeorm`'s `getCurrentEntityManager`, so
  publication rows commit atomically with the business data when the
  caller is inside a `@Transactional()` scope.
- `tryClaim` issues a single conditional `UPDATE`
  (`WHERE id = :id AND status IN (PUBLISHED, RESUBMITTED)`) and
  returns whether the row was actually transitioned — atomic under
  concurrent workers.
- `findReadyForProcessing` uses
  `SELECT ... FOR UPDATE SKIP LOCKED` so multiple workers can poll
  without fighting for the same rows.
- `archiveCompleted` copies the row into
  `event_publication_archive` and then deletes it from the hot queue
  — atomicity comes from the ambient transaction the processor wraps
  the listener invocation in.

## Installation (once published)

```bash
pnpm add @nestjs-transactional/core \
         @nestjs-transactional/typeorm \
         @nestjs-transactional/outbox \
         @nestjs-transactional/outbox-typeorm
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/typeorm`,
`reflect-metadata`, `rxjs`, `typeorm`.

## Usage

Full wiring for an application that publishes, processes, and
recovers events against a TypeORM-backed registry:

```typescript
import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  OutboxModule,
  OutboxProcessingModule,
} from '@nestjs-transactional/outbox';
import {
  EventPublicationEntity,
  EventPublicationArchiveEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';

import { OrderPlacedEvent } from './events';

const dataSource = new DataSource({
  type: 'postgres',
  // ...
  entities: [
    EventPublicationEntity,
    EventPublicationArchiveEntity,
    // ...your domain entities
  ],
});

@Module({
  imports: [
    // 1. Core transaction infrastructure — must be global so
    //    downstream modules can see TransactionManager.
    TransactionalModule.forRoot({ isGlobal: true }),

    // 2. TypeORM adapter registration. `forRoot` resolves the
    //    actual DataSource via @nestjs/typeorm's
    //    `getDataSourceToken(name)` — so `TypeOrmModule.forRoot(...)`
    //    must be imported above this. Activates transparent
    //    transactional Repository dispatch.
    TypeOrmTransactionalModule.forRoot({ isDefault: true }),

    // 3. Outbox-typeorm registration. `forRoot` resolves the
    //    DataSource from DI (same pattern as
    //    TypeOrmTransactionalModule). Registers the
    //    `TypeOrmEventPublicationRepository` under a private per-DS
    //    token; the cross-module bridge
    //    `typeOrmEventPublicationRepositoryProvider()` (passed to
    //    `OutboxModule.forRoot` below) aliases the official outbox
    //    token to that private one. The `SchemaInitializer` is
    //    instantiated per-DS — production should disable it and
    //    apply the shipped TypeORM migration instead.
    OutboxTypeOrmModule.forRoot({
      schemaInitialization: { enabled: process.env.NODE_ENV !== 'production' },
    }),

    // 4. Outbox-core wiring. Forward the TypeORM repository via the
    //    aliasing Provider so outbox does NOT install its
    //    InMemory default.
    OutboxModule.forRoot({
      repository: typeOrmEventPublicationRepositoryProvider(),
      republishOnStartup: true,
      processor: { pollingInterval: 1000, batchSize: 100 },
      staleness: { processing: 60_000, monitorInterval: 30_000 },
    }),

    // 5. Register the event classes the outbox should know about.
    //    Each feature module would normally call forFeature() for the
    //    events it owns; this single-module example collapses them.
    OutboxModule.forFeature([OrderPlacedEvent]),

    // 6. Only in worker processes — starts the processor and
    //    staleness monitor on bootstrap. API-only apps that just
    //    publish events should NOT import this.
    OutboxProcessingModule,
  ],
})
export class AppModule {}
```

### Why the `repository` forwarding provider

`OutboxModule.forRoot` defaults to
`InMemoryEventPublicationRepository` for the
`EVENT_PUBLICATION_REPOSITORY` token when `repository` is omitted.
Passing `typeOrmEventPublicationRepositoryProvider` replaces that
default with a `useExisting` alias pointing at the TypeORM
implementation registered by `OutboxTypeOrmModule.forFeature`. Leaving
the option out would install two providers for the same token —
the InMemory one would win and your publications would never reach
the database.

### Publishing events

```typescript
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox';

@Injectable()
export class PlaceOrderHandler {
  constructor(private readonly outbox: OutboxEventPublisher) {}

  @Transactional()
  async handle(orderId: string): Promise<void> {
    // ...persist business data in the same transaction...
    await this.outbox.publish(new OrderPlacedEvent(orderId));
  }
}
```

The publication row commits atomically with the business data. If
the transaction rolls back, the publication row is rolled back too
— there is no "event published without the business change landing"
failure mode.

### Declaring a handler

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
    // Runs in a fresh REQUIRES_NEW transaction after the publishing
    // transaction has committed, retried on exception, resumable
    // across process restarts.
  }
}
```

## Schema management

Two supported paths, matching Spring Modulith's split between
reviewed schema changes and the
`spring.modulith.events.jdbc.schema-initialization.enabled`
developer shortcut.

### Production: run the TypeORM migration (preferred)

The package ships a ready-to-use migration,
`CreateEventPublication1700000000000`, that creates both
`event_publication` and `event_publication_archive` with every
index. Register it with your DataSource and run it through the
TypeORM CLI as part of your deploy:

```typescript
// data-source.ts
import { DataSource } from 'typeorm';
import { CreateEventPublication1700000000000 } from '@nestjs-transactional/outbox-typeorm';

export const dataSource = new DataSource({
  type: 'postgres',
  // ...
  migrations: [CreateEventPublication1700000000000, /* ...your own */],
});
```

```bash
pnpm typeorm migration:run -d ./dist/data-source.js
```

The timestamp `1700000000000` is a placeholder chosen to sort
before most application-owned migrations. Feel free to copy the
migration file into your own `migrations/` directory and rename it
to match your team's timestamp convention — the migration body is
just a call to `applyEventPublicationSchema(queryRunner)` from this
package, so keeping a thin wrapper in your own tree is encouraged.

### Development: auto-init at bootstrap

Useful for local development and integration suites that spin a
fresh database up per run. `SchemaInitializer` is a
NestJS-lifecycle-aware provider that creates both tables on
application bootstrap when its `enabled` option is set:

```typescript
import { Module } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  SchemaInitializer,
  SCHEMA_INITIALIZATION_OPTIONS,
} from '@nestjs-transactional/outbox-typeorm';

@Module({
  providers: [
    {
      provide: SCHEMA_INITIALIZATION_OPTIONS,
      useValue: { enabled: process.env.NODE_ENV !== 'production' },
    },
    {
      provide: SchemaInitializer,
      useFactory: (ds: DataSource, opts) => new SchemaInitializer(ds, opts),
      inject: [getDataSourceToken(), SCHEMA_INITIALIZATION_OPTIONS],
    },
  ],
})
export class OutboxSchemaModule {}
```

The initializer is a no-op when `enabled: false`. When enabled and
the hot table already exists, it logs a debug line and bails out
before running any DDL — safe to leave on across restarts. **Do
not enable in production** — schema changes should always go
through a reviewed migration.

## Using with `@nestjs-transactional/cqrs`

When the application uses `@nestjs/cqrs` aggregates, bind
`OutboxEventPublisher` under the cqrs package's
`OUTBOX_PUBLICATION_SCHEDULER` token AND bind
`OutboxListenerRegistry` under `OUTBOX_LISTENER_REGISTRAR`.
`HybridEventPublisher` (wired by `CqrsTransactionalModule.forRoot()`)
then routes every `aggregate.commit()` through both the in-memory
phase-aware dispatcher AND the outbox, and
`IntegrationEventsHandlerScanner` routes
`@IntegrationEventsHandler` classes through the outbox worker.
See [`../cqrs/README.md#outbox-integration`](../cqrs/README.md#outbox-integration)
for the full wiring recipe and the trade-offs between
`@TransactionalEventsHandler`, `@OutboxEventsHandler`, and
`@IntegrationEventsHandler`.

## Testing

Integration tests live under `test/integration/` and rely on
[`testcontainers-node`](https://node.testcontainers.org/) to spin up
a real Postgres 16 container for every run. Requires Docker to be
running locally:

```bash
pnpm --filter @nestjs-transactional/outbox-typeorm test:integration
```

Unit-test-only runs (`pnpm test`) skip the integration suite per the
shared Jest base config.

## Worked examples

- [`basic-typeorm-outbox`](../../examples/basic-typeorm-outbox) — single-DS outbox with Postgres, atomicity proven by testcontainers.
- [`multi-datasource-outbox`](../../examples/multi-datasource-outbox) — per-DS `event_publication` tables (ADR-019 multi-`forRoot`).
- [`shared-database-modular-monolith`](../../examples/shared-database-modular-monolith) — one Postgres, multi-schema, per-module outbox stacks.
- [`saga-pattern`](../../examples/saga-pattern), [`audit-logging`](../../examples/audit-logging) — outbox-driven business saga and asymmetric audit-DS sink.
- [`e-commerce-orders`](../../examples/e-commerce-orders) — three-DataSource flagship using `OutboxTypeOrmModule.forRoot` per DS.

Full catalogue: [examples/README.md](../../examples/README.md).

## License

MIT
