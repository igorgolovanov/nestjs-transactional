# @nestjs-transactional/cqrs

Integration between [@nestjs-transactional/core](../core) and
[`@nestjs/cqrs`](https://docs.nestjs.com/recipes/cqrs). Gives
`@CommandHandler` / `@QueryHandler` / `@EventsHandler` classes
declarative transaction management and Spring-style event listener
phases without forking `@nestjs/cqrs` (see ADR-003).

## What it provides

- **`@TransactionalEventsListener(EventType, { phase, fallbackExecution, async })`** —
  event listener decorator with Spring-compatible phases:
  `BEFORE_COMMIT`, `AFTER_COMMIT` (default), `AFTER_ROLLBACK`,
  `AFTER_COMPLETION`.
- **`TransactionalEventPublisher` + `TransactionalEventPublisherAdapter`** —
  drop-in replacement for `@nestjs/cqrs`'s `EventPublisher`.
  `AggregateRoot.commit()` routes events through the transactional
  dispatcher, so `AFTER_COMMIT` listeners only fire once the transaction
  actually commits — no more "event published, then transaction rolled
  back" race.
- **`CqrsHandlerWrapper` + `CqrsTransactionalBootstrap`** — bootstrap-time
  wrapping of every `@CommandHandler` / `@QueryHandler` / `@EventsHandler`
  instance that carries `@Transactional()` metadata (method-level or
  class-level), or matches kind-specific defaults (e.g. read-only
  wrapping for queries).
- **`TransactionalListenerScanner`** — `OnModuleInit` scanner that
  auto-registers every `@TransactionalEventsListener` method with the
  event dispatcher.
- **`CqrsTransactionalModule.forRoot({...})`** — single entry point that
  wires all of the above.

Peer dependencies: `@nestjs-transactional/core`, `@nestjs/cqrs ^11`,
`@nestjs/common ^10 || ^11`, `@nestjs/core ^10 || ^11`, `rxjs ^7`,
`reflect-metadata`.

## Module configuration

```ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import { CqrsTransactionalModule } from '@nestjs-transactional/cqrs';

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forFeature({ dataSource: myDataSource }),
    CqrsTransactionalModule.forRoot({
      // every option has a sensible default — shown here for completeness
      wrapCommandHandlers: true,
      wrapQueryHandlers: true,
      wrapEventHandlers: true,
      defaultQueryOptions: { readOnly: true },
      // defaultCommandOptions: { propagation: PropagationMode.REQUIRED },
      useTransactionalEventPublisher: true,
    }),
  ],
})
export class AppModule {}
```

**Important**: do NOT import `CqrsModule` separately alongside
`CqrsTransactionalModule.forRoot()`. The transactional module imports
`CqrsModule` internally and overrides the `EventPublisher` DI token —
importing `CqrsModule` a second time in the consumer shadows the
override with the original.

## Full example

An order placement flow, end-to-end:

```ts
// aggregate.ts
import { AggregateRoot } from '@nestjs/cqrs';

export class OrderPlacedEvent {
  constructor(public readonly orderId: string) {}
}

export class Order extends AggregateRoot {
  constructor(public readonly id: string) {
    super();
  }
  place(): void {
    this.apply(new OrderPlacedEvent(this.id));
  }
}
```

```ts
// order.repository.ts
import { Injectable } from '@nestjs/common';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { OrderRow } from './order.entity';

@Injectable()
export class OrderRepository {
  async save(order: { id: string }): Promise<void> {
    const em = getCurrentEntityManager('default');
    await em.save(OrderRow, { id: order.id });
  }
}
```

```ts
// place-order.handler.ts
import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { Transactional } from '@nestjs-transactional/core';
import { Order } from './aggregate';
import { OrderRepository } from './order.repository';

export class PlaceOrderCommand {
  constructor(public readonly orderId: string) {}
}

@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, void> {
  constructor(
    private readonly publisher: EventPublisher,
    private readonly repo: OrderRepository,
  ) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order(command.orderId));
    order.place();
    await this.repo.save(order);
    order.commit(); // events attach as AFTER_COMMIT hooks on the current tx
  }
}
```

```ts
// order.projection.ts
import { Injectable } from '@nestjs/common';
import {
  TransactionalEventsListener,
  TransactionPhase,
} from '@nestjs-transactional/cqrs';
import { OrderPlacedEvent } from './aggregate';

@Injectable()
export class OrderProjection {
  @TransactionalEventsListener(OrderPlacedEvent)
  async onPlaced(event: OrderPlacedEvent): Promise<void> {
    // runs AFTER the transaction commits, not before
    // safe to do side effects here — the DB write is durable
  }

  @TransactionalEventsListener(OrderPlacedEvent, { phase: TransactionPhase.AFTER_ROLLBACK })
  onPlacedRollback(event: OrderPlacedEvent, error: unknown): void {
    // compensating action; receives the rollback cause
  }
}
```

What happens when `commandBus.execute(new PlaceOrderCommand('o-1'))` is
dispatched:

1. `CqrsHandlerWrapper` has replaced `PlaceOrderHandler.execute` with a
   `TransactionManager.run(...)` wrapper at application bootstrap. The
   dispatch enters a new transaction.
2. Inside the wrapped execute, the aggregate's `publishAll` goes through
   `TransactionalEventPublisher`, which calls
   `TransactionalEventDispatcher.scheduleDispatch(event)`. The
   dispatcher attaches `onPlaced` as an `AFTER_COMMIT` hook on the
   current transaction, and `onPlacedRollback` as an `AFTER_ROLLBACK`
   hook.
3. The repository's `getCurrentEntityManager('default')` resolves to
   the transaction's own `EntityManager` — both writes go through the
   same DB connection.
4. `execute` resolves; `TransactionManager` commits the transaction;
   the adapter flushes to the database.
5. After the commit succeeds, the manager runs `AFTER_COMMIT` hooks —
   `OrderProjection.onPlaced` fires once, with a row already visible
   in the database.
6. On a thrown error, step 4 rolls back instead; step 5 runs
   `AFTER_ROLLBACK` hooks — `OrderProjection.onPlacedRollback` fires,
   receiving the original error.

## Listener phases at a glance

| Phase | When it fires | If listener throws |
|---|---|---|
| `BEFORE_COMMIT` | Before the adapter issues COMMIT | Transaction rolls back |
| `AFTER_COMMIT` *(default)* | After a successful COMMIT | Logged and swallowed |
| `AFTER_ROLLBACK` | After ROLLBACK; receives the causing error as second arg | Logged and swallowed |
| `AFTER_COMPLETION` | On any completion (commit OR rollback) | Logged and swallowed |

`{ fallbackExecution: true }` makes a listener fire directly (via
`queueMicrotask`) when the event is published outside any transaction.
Otherwise out-of-transaction events are dropped with a warning.

`{ async: true }` fires the listener via `queueMicrotask` even inside a
transaction — its errors never reach the transaction's rollback path.
Useful for genuinely fire-and-forget side effects.

## Defaults baked into `CqrsTransactionalModule.forRoot()`

- Command handlers are wrapped in `REQUIRED`-propagation transactions.
  Without method- or class-level `@Transactional()`, they remain unwrapped
  unless `defaultCommandOptions` is provided.
- Query handlers are wrapped as read-only transactions by default
  (`defaultQueryOptions: { readOnly: true }`). Pass
  `defaultQueryOptions: undefined` to opt out.
- Event handlers are wrapped only if they carry `@Transactional()` (no
  kind-level default is applied to events — they are often used for
  out-of-band side effects where wrapping is inappropriate).
- `AggregateRoot.commit()` routes events through the dispatcher — set
  `useTransactionalEventPublisher: false` to leave `@nestjs/cqrs`'s
  standard `EventPublisher` in place (useful for gradual adoption).

## Limitations

- Only works with **singleton** handlers. Request-scoped CQRS handlers
  are resolved per-request by `@nestjs/cqrs` via `ModuleRef.resolve(...)`,
  producing a fresh instance our bootstrap wrap has not mutated.
- Direct `eventBus.publish(...)` calls (outside of an aggregate) do NOT
  go through the transactional dispatcher — only `AggregateRoot.commit()`
  -emitted events via `mergeObjectContext` / `mergeClassContext`. If you
  need phase-aware listeners on bus-published events, publish them from
  an aggregate instead.
- `@nestjs/cqrs`'s handler-metadata constants are read via hardcoded
  string literals (`__commandHandler__`, etc.) because `@nestjs/cqrs`
  does not re-export them. See `handler-wrapper.ts` — CLAUDE.md DD-002
  documents this coupling.

## Status

Work in progress. Not yet published to npm.
