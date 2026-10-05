---
'@nestjs-transactional/core': major
'@nestjs-transactional/typeorm': major
'@nestjs-transactional/cqrs': major
'@nestjs-transactional/outbox': major
---

cqrs events go through the `@nestjs/cqrs` EventBus, and NestJS 10 leaves the peer ranges

`CqrsTransactionalModule` no longer overrides `EventPublisher`. It
imports `CqrsModule.forRoot()` with its own publisher in the `EventBus`,
so every event, from `aggregate.commit()` or `eventBus.publish()`,
schedules its transaction phases and the outbox, then reaches
`@EventsHandler`s and sagas. Inside `@Transactional`, the bus hands its
publisher chain `{ transaction }`, which makes `@nestjs/cqrs` 12.1's
`commit(context)` work and lets `@nestjs/workflows`' `@StartOn` and
`@SignalOn` write in the business transaction. Why: ADR-024. The
contract: DD-029. Upgrading: section 7 of
`docs/guides/migrating-to-3.md`.

### Breaking

- **NestJS 10 is no longer supported** by core, typeorm or cqrs. It was
  declared and never tested. CI now runs NestJS 11 with `@nestjs/cqrs`
  11.0.3, and NestJS 12 with 12.1.
- **`@EventsHandler`s and sagas receive aggregate events**, at once and
  inside the transaction, as `@nestjs/cqrs` delivers any publish.
- **A direct `eventBus.publish()` schedules phase handlers** and, for an
  `@Externalized` event with the outbox wired, the outbox.
- **Inside a transaction, the dispatcher context** of a publish without
  one, or with the aggregate, is `{ transaction, aggregate? }`.
- **Removed from cqrs**: `HybridEventPublisher`,
  `TransactionalEventPublisher`, `TransactionalEventPublisherAdapter`,
  `AggregateConstructor` and the `useTransactionalEventPublisher` option.
  `CqrsModule` options go to `CqrsTransactionalModule.forRoot({ cqrs })`,
  a bus publisher of your own to `forRoot({ eventPublisher })`.
- **Bootstrap fails** when a second `EventBus` exists or
  `EventBus.publisher` no longer reaches the transactional publisher.

### Added

- `CommandBus`, `QueryBus` and `EventBus` are injectable anywhere in the
  application.
- core: an optional adapter SPI method, `nativeTransaction(handle)`, and
  `dialect`; `TransactionManager.nativeTransactionOf(active)` and
  `TransactionManager.trackPending(active, promise)`.
- typeorm: the adapter implements `nativeTransaction` (the transactional
  `EntityManager`) and `dialect`.
- outbox: the default `transactionResolver` asks the adapter for its
  native transaction instead of reading `handle.entityManager`.
