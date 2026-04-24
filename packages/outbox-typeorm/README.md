# @nestjs-transactional/outbox-typeorm

TypeORM persistence backend for
[`@nestjs-transactional/outbox-core`](../outbox-core). Ships the
`event_publication` table schema, a TypeORM-backed implementation of
the `EventPublicationRepository` SPI, and (in a later iteration) the
NestJS module wiring.

## Status

**Alpha / in development.** Iteration 6.2 delivered the entities and
the repository implementation; Iteration 6.3 adds the schema migration
and a `SchemaInitializer` for development-time auto-init. Module
wiring (`OutboxTypeOrmModule`) arrives in a subsequent iteration. The
public API is not yet stable and will change between 0.x releases.

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
`EventPublicationRepository` from `outbox-core`. Highlights:

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
         @nestjs-transactional/outbox-core \
         @nestjs-transactional/outbox-typeorm
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/typeorm`,
`reflect-metadata`, `rxjs`, `typeorm`.

## Usage (manual wiring, pending `OutboxTypeOrmModule`)

Until the module wiring lands, the repository can be constructed and
provided manually:

```typescript
import { EVENT_PUBLICATION_REPOSITORY } from '@nestjs-transactional/outbox-core';
import {
  EventPublicationEntity,
  EventPublicationArchiveEntity,
  TypeOrmEventPublicationRepository,
} from '@nestjs-transactional/outbox-typeorm';

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forFeature({ dataSource }),
    TypeOrmModule.forFeature([EventPublicationEntity, EventPublicationArchiveEntity]),
    OutboxModule.forRoot({
      eventTypes: [/* ... */],
      repository: {
        provide: EVENT_PUBLICATION_REPOSITORY,
        useFactory: (ds: DataSource) => new TypeOrmEventPublicationRepository(ds),
        inject: [getDataSourceToken()],
      },
    }),
  ],
})
export class AppModule {}
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

## License

MIT
