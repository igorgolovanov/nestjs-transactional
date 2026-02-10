# @nestjs-transactional/outbox-typeorm

TypeORM persistence backend for
[`@nestjs-transactional/outbox-core`](../outbox-core). Provides the
`event_publication` table, a TypeORM-based implementation of the
`EventPublicationRepository` SPI, and NestJS module wiring.

## Status

**Alpha / in development.** This package is being built iteratively as
part of Phase 6 of the monorepo roadmap. The public API is not yet
stable and will change between 0.x releases. This revision only ships
the package skeleton — entity classes, the repository implementation,
migrations, and module wiring land in subsequent iterations.

## Planned features

- `EventPublicationEntity` with the indexes needed for the worker
  (listener_id, status, publication_date).
- `EventPublicationArchiveEntity` for the `ARCHIVE` completion mode.
- `TypeOrmEventPublicationRepository` implementing the SPI from
  `outbox-core`, using `FOR UPDATE SKIP LOCKED` for safe concurrent
  worker polling.
- SQL migration (`createEventPublication`) plus a development-only
  auto schema initialization helper.
- `OutboxTypeOrmModule.forRoot` / `forRootAsync` that registers the
  repository provider under `EVENT_PUBLICATION_REPOSITORY`.

## Installation (once published)

```bash
pnpm add @nestjs-transactional/core \
         @nestjs-transactional/typeorm \
         @nestjs-transactional/outbox-core \
         @nestjs-transactional/outbox-typeorm
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/typeorm`,
`reflect-metadata`, `rxjs`, `typeorm`.

## License

MIT
