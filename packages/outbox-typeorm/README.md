# @nestjs-transactional/outbox-typeorm

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox-typeorm/alpha?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox-typeorm)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

TypeORM storage for
[`@nestjs-transactional/outbox`](https://www.npmjs.com/package/@nestjs-transactional/outbox).

`outbox` defines the registry and the worker but ships no production
storage. This package provides it: the `event_publication` table, its
archive, a repository implementation, and a migration to create both.

Publication rows are written through the ambient transaction, so they
commit with your business data or not at all — that is the guarantee the
whole pattern rests on, and it comes from the transparent repository
support in
[`@nestjs-transactional/typeorm`](https://www.npmjs.com/package/@nestjs-transactional/typeorm).

> **Alpha.** The public API is stable in intent but may still change
> before `1.0.0`.

## Install

```bash
pnpm add @nestjs-transactional/outbox-typeorm \
         @nestjs-transactional/outbox \
         @nestjs-transactional/typeorm \
         @nestjs-transactional/core
```

## Quick start

Register the two entities on your `DataSource`, then wire four modules
in this order:

```ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';
import {
  EventPublicationArchiveEntity,
  EventPublicationEntity,
  OutboxTypeOrmModule,
  typeOrmEventPublicationRepositoryProvider,
} from '@nestjs-transactional/outbox-typeorm';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      entities: [EventPublicationEntity, EventPublicationArchiveEntity, Order],
    }),

    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot({ isDefault: true }),

    // Auto-create the tables in development only — production runs the
    // migration instead. See Schema below.
    OutboxTypeOrmModule.forRoot({
      schemaInitialization: { enabled: process.env.NODE_ENV !== 'production' },
    }),

    OutboxModule.forRoot({
      // Required. Without it `outbox` keeps its in-memory default and
      // nothing is persisted — see the warning below.
      repository: typeOrmEventPublicationRepositoryProvider(),
      republishOnStartup: true,
    }),

    OutboxModule.forFeature([OrderPlacedEvent]),

    OutboxProcessingModule, // worker processes only
  ],
})
export class AppModule {}
```

> **`repository` is not optional in practice.** `OutboxModule.forRoot()`
> installs `InMemoryEventPublicationRepository` when the option is
> omitted, and that provider wins. The application works — publishes,
> handles, completes — and every publication is lost on restart, with
> nothing in the database and no error to notice.
> `typeOrmEventPublicationRepositoryProvider()` aliases the outbox's
> token to the TypeORM implementation this module registers.

## Schema

Two tables. `event_publication` is the hot queue; `event_publication_archive`
is the cold audit trail used by the `ARCHIVE` completion mode. Four
indexes cover the worker, operator and cleanup paths — `(status,
publicationDate)`, `(status, listenerId)`, `(eventType)` and
`(completionDate)`. `status` is `varchar(32)` rather than an enum, so a
new lifecycle state never forces a type migration.

**In production, run the shipped migration:**

```ts
import { CreateEventPublication1700000000000 } from '@nestjs-transactional/outbox-typeorm';

// In your DataSource config:
migrations: [CreateEventPublication1700000000000];
```

**In development**, `schemaInitialization: { enabled: true }` creates
both tables at bootstrap instead. It is idempotent and checks for
existing tables first, but it is still schema DDL at application
startup: keep it out of production, where a migration gives you a
reviewable, ordered, reversible change.

## Concurrency

`tryClaim` is one conditional `UPDATE`
(`WHERE id = :id AND status IN (PUBLISHED, RESUBMITTED)`) that reports
whether the row actually transitioned. That is where the safety lives,
which is why `findReadyForProcessing` deliberately does **not** lock
rows.

`SELECT ... FOR UPDATE SKIP LOCKED` was tried and dropped: a pessimistic
lock has to be held by a transaction wide enough to span the listener
invocation, which is unsafe when listeners are slow. Concurrent workers
may therefore fetch the same row; only one wins the claim, and the
others move on without invoking anything. The cost is a wasted `SELECT`
at typical worker counts
([DD-025](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/025-claim-atomicity-obligation.md)).

## Multiple dataSources

One `forRoot` per dataSource, mirroring the other packages:

```ts
OutboxTypeOrmModule.forRoot(),                          // 'default'
OutboxTypeOrmModule.forRoot({ dataSource: 'billing' }), // 'billing'
```

Each registers its repository under a per-dataSource token; pass the
matching name to `typeOrmEventPublicationRepositoryProvider('billing')`
when wiring that dataSource's `OutboxModule`
([ADR-019](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/019-outbox-multi-forroot-pattern.md)).
`forRootAsync` is available for config resolved at runtime.

## Compatibility

| Peer | Supported range |
| --- | --- |
| Node.js | `>=22.13.0` |
| `typeorm` | `^0.3.0 \|\| ^1.0.0` |
| `@nestjs/typeorm` | `^10.0.0 \|\| ^11.0.0` |
| `@nestjs/common` / `@nestjs/core` | `^10.0.0 \|\| ^11.0.0` |
| `reflect-metadata` | `^0.1.13 \|\| ^0.2.0` |
| `rxjs` | `^7.0.0` |

CI exercises the repository against a real Postgres via testcontainers
at three points of the TypeORM range: `0.3.31`, `1.0.0` and `1.1.0`.

## Documentation

- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)
- [Architecture: the outbox pattern](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/architecture/outbox-pattern.md)
- [Outbox architecture (ADR-007)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/007-outbox-architecture.md)
- Runnable examples:
  [`basic-typeorm-outbox`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/basic-typeorm-outbox),
  [`multi-datasource-outbox`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/multi-datasource-outbox),
  [`shared-database-modular-monolith`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/shared-database-modular-monolith)

## License

MIT
