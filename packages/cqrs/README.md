# @nestjs-transactional/cqrs

Integration between [@nestjs-transactional/core](../core) and [`@nestjs/cqrs`](https://docs.nestjs.com/recipes/cqrs).

Provides:

- `@TransactionalEventsListener(EventType, { phase, fallbackExecution, async })` — Spring-semantic event listener with `BEFORE_COMMIT` / `AFTER_COMMIT` / `AFTER_ROLLBACK` / `AFTER_COMPLETION` phases.
- `TransactionalEventPublisher` — drop-in replacement for `@nestjs/cqrs`'s `EventPublisher`; `AggregateRoot.commit()` registers events as transaction hooks instead of publishing them immediately.
- `CqrsHandlerWrapper` — bootstrap-time wrapping of `@CommandHandler` / `@QueryHandler` / `@EventsHandler` instances when they carry `@Transactional()` metadata.
- `CqrsTransactionalModule.forRoot({ wrapCommandHandlers, wrapQueryHandlers, wrapEventHandlers, defaultQueryOptions, defaultCommandOptions, useTransactionalEventPublisher })`.

Works without `@nestjs-transactional/typeorm` — use with any `TransactionAdapter`.

Requires `@nestjs-transactional/core` and `@nestjs/cqrs` as peer dependencies. Does not fork `@nestjs/cqrs` — see ADR-003.

## Status

Work in progress. Not yet published to npm.
