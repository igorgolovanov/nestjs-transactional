# @nestjs-transactional/outbox-typeorm

TypeORM persistence backend for
[`@nestjs-transactional/outbox-core`](../outbox-core). Ships the
`event_publication` table schema, a TypeORM-backed implementation of
the `EventPublicationRepository` SPI, and (in a later iteration) the
NestJS module wiring.

## Status

**Alpha / in development.** Iteration 6.2 delivers the entities and the
repository implementation. Module wiring and migration helpers arrive
in subsequent iterations. Public API is not yet stable and will change
between 0.x releases.

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

This revision does **not** ship a generated migration. Until one
lands, development environments can rely on TypeORM's `synchronize`
flag (or call `dataSource.synchronize()` once at startup). Production
deployments should use a migration step — instructions will ship in
Iteration 6.x alongside the migration helper.

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
