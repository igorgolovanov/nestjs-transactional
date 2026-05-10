# @nestjs-transactional/cqrs

Integration between [@nestjs-transactional/core](../core) and
[`@nestjs/cqrs`](https://docs.nestjs.com/recipes/cqrs). Gives
`@CommandHandler` / `@QueryHandler` / `@EventsHandler` classes
declarative transaction management and Spring-style event handler
phases without forking `@nestjs/cqrs` (see ADR-003).

## What it provides

- **`@TransactionalEventsHandler(...events)`** — class-level event
  handler decorator with Spring-compatible phases: `BEFORE_COMMIT`,
  `AFTER_COMMIT` (default), `AFTER_ROLLBACK`, `AFTER_COMPLETION`. The
  decorated class implements `ITransactionalEventHandler<T>` and
  exposes a single `handle(event)` method. Matches the ergonomics of
  `@nestjs/cqrs`'s own `@EventsHandler` (see ADR-014).
- **`@IntegrationEventsHandler(...events)`** — class-level smart
  default for cross-module handlers. Delivers via the outbox when the
  `OUTBOX_LISTENER_REGISTRAR` structural port is bound (durable,
  retried, resumable), falls back to in-memory `AFTER_COMMIT` + `async:
  true` dispatch otherwise. Matches Spring Modulith's
  `@ApplicationModuleListener` contract.
- **`TransactionalEventPublisher` + `TransactionalEventPublisherAdapter`** —
  drop-in replacement for `@nestjs/cqrs`'s `EventPublisher`.
  `AggregateRoot.commit()` routes events through the transactional
  dispatcher, so `AFTER_COMMIT` handlers only fire once the
  transaction actually commits — no more "event published, then
  transaction rolled back" race.
- **`HybridEventPublisher`** — the strategy wired by
  `CqrsTransactionalModule.forRoot()` into the `EventPublisher`
  override. Routes aggregate events through the in-memory dispatcher
  AND, when an outbox scheduler is bound to the
  `OUTBOX_PUBLICATION_SCHEDULER` token, also through
  `@nestjs-transactional/outbox` for durable delivery. Without
  the outbox binding, behaves identically to
  `TransactionalEventPublisher`.
- **`CqrsHandlerWrapper` + `CqrsTransactionalBootstrap`** — bootstrap-time
  wrapping of every `@CommandHandler` / `@QueryHandler` / `@EventsHandler`
  instance that carries `@Transactional()` metadata (method-level or
  class-level), or matches kind-specific defaults (e.g. read-only
  wrapping for queries).
- **`TransactionalListenerScanner` +
  `IntegrationEventsHandlerScanner`** — `OnModuleInit` scanners that
  auto-register every `@TransactionalEventsHandler` /
  `@IntegrationEventsHandler` class with the appropriate delivery
  path.
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
    TypeOrmTransactionalModule.forRoot(),
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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderRow } from './order.entity';

@Injectable()
export class OrderRepository {
  constructor(
    @InjectRepository(OrderRow) private readonly rows: Repository<OrderRow>,
  ) {}

  async save(order: { id: string }): Promise<void> {
    // Phase 14.20: the @InjectRepository instance auto-dispatches
    // through the active @Transactional() scope's EntityManager —
    // no getCurrentEntityManager() boilerplate needed.
    await this.rows.save({ id: order.id });
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
  type ITransactionalEventHandler,
  TransactionPhase,
  TransactionalEventsHandler,
} from '@nestjs-transactional/cqrs';
import { OrderPlacedEvent } from './aggregate';

@Injectable()
@TransactionalEventsHandler(OrderPlacedEvent)
export class OrderCommittedProjection
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    // Runs AFTER the transaction commits, not before. Safe to do side
    // effects here — the DB write is durable.
  }
}

@Injectable()
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  phase: TransactionPhase.AFTER_ROLLBACK,
})
export class OrderRollbackProjection
  implements ITransactionalEventHandler<OrderPlacedEvent>
{
  handle(event: OrderPlacedEvent, error?: unknown): void {
    // Compensating action; receives the rollback cause as the second
    // argument (added beyond the interface signature — TypeScript
    // permits widening the parameter list on the implementation).
  }
}
```

Note the class-per-reaction shape: `OrderCommittedProjection` reacts
to the AFTER_COMMIT phase, `OrderRollbackProjection` to
AFTER_ROLLBACK. Each class has one `handle` method because each class
has one responsibility — see ADR-014 for the rationale.

What happens when `commandBus.execute(new PlaceOrderCommand('o-1'))` is
dispatched:

1. `CqrsHandlerWrapper` has replaced `PlaceOrderHandler.execute` with a
   `TransactionManager.run(...)` wrapper at application bootstrap. The
   dispatch enters a new transaction.
2. Inside the wrapped execute, the aggregate's `publishAll` goes through
   `TransactionalEventPublisher`, which calls
   `TransactionalEventDispatcher.scheduleDispatch(event)`. The
   dispatcher attaches `OrderCommittedProjection.handle` as an
   `AFTER_COMMIT` hook on the current transaction, and
   `OrderRollbackProjection.handle` as an `AFTER_ROLLBACK` hook.
3. The repository's `@InjectRepository(OrderRow)` Repository
   auto-dispatches through the active transaction (Phase 14.20
   transparent transactional repositories) — both writes go through
   the same DB connection.
4. `execute` resolves; `TransactionManager` commits the transaction;
   the adapter flushes to the database.
5. After the commit succeeds, the manager runs `AFTER_COMMIT` hooks —
   `OrderCommittedProjection.handle` fires once, with a row already
   visible in the database.
6. On a thrown error, step 4 rolls back instead; step 5 runs
   `AFTER_ROLLBACK` hooks — `OrderRollbackProjection.handle` fires,
   receiving the original error.

## Decorator shapes — rest params vs. options object

Every handler decorator accepts two equivalent forms:

```ts
// Short form — rest params. Use when defaults are fine.
@TransactionalEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
@OutboxEventsHandler(OrderPlacedEvent)
@IntegrationEventsHandler(OrderPlacedEvent)

// Long form — options object. Use when you need non-default phase,
// async, fallbackExecution, or a stable listener id.
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  phase: TransactionPhase.BEFORE_COMMIT,
  async: false,
  fallbackExecution: true,
})
@IntegrationEventsHandler({
  events: [OrderPlacedEvent],
  id: 'Inventory.stable-id',
})
```

## Handler phases at a glance

| Phase | When it fires | If handler throws |
|---|---|---|
| `BEFORE_COMMIT` | Before the adapter issues COMMIT | Transaction rolls back |
| `AFTER_COMMIT` *(default)* | After a successful COMMIT | Logged and swallowed |
| `AFTER_ROLLBACK` | After ROLLBACK; receives the causing error as second arg | Logged and swallowed |
| `AFTER_COMPLETION` | On any completion (commit OR rollback) | Logged and swallowed |

`{ fallbackExecution: true }` makes a handler fire directly (via
`queueMicrotask`) when the event is published outside any transaction.
Otherwise out-of-transaction events are dropped with a warning.

`{ async: true }` fires the handler via `queueMicrotask` even inside a
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

## Outbox integration

`CqrsTransactionalModule.forRoot()` always wires `HybridEventPublisher`
into the `EventPublisher` DI override. By default, `HybridEventPublisher`
routes events only through the in-memory dispatcher — no outbox side
effects. To turn on durable delivery, bind BOTH structural ports in
your app module:

```ts
import { Module } from '@nestjs/common';
import {
  OutboxEventPublisher,
  OutboxListenerRegistry,
  OutboxModule,
} from '@nestjs-transactional/outbox';
import {
  CqrsTransactionalModule,
  OUTBOX_LISTENER_REGISTRAR,
  OUTBOX_PUBLICATION_SCHEDULER,
} from '@nestjs-transactional/cqrs';

@Module({
  imports: [
    // ...the usual wiring — TransactionalModule, a typeorm adapter,
    // OutboxTypeOrmModule, OutboxModule, CqrsTransactionalModule...
    CqrsTransactionalModule.forRoot(),
  ],
  providers: [
    // Routes AggregateRoot.commit() events to the outbox for durable
    // publication.
    { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
    // Routes @IntegrationEventsHandler classes to the outbox registry
    // for durable delivery.
    { provide: OUTBOX_LISTENER_REGISTRAR, useExisting: OutboxListenerRegistry },
  ],
})
export class AppModule {}
```

With both bindings in place, a single `aggregate.commit()` call:

1. Attaches one `AFTER_COMMIT` hook per `@TransactionalEventsHandler`
   class registered for the event — fires after the transaction
   commits, entirely in-memory, no DB rows.
2. Buffers the event for outbox publication — a single
   `beforeCommit` hook per transaction flushes the whole buffer into
   `event_publication` rows, atomically with the business write.
3. Once the transaction commits, the outbox processor (running in
   a worker) polls those rows and invokes every
   `@OutboxEventsHandler` / `@IntegrationEventsHandler` class
   registered for the event.

Rollback rolls back all three: no in-memory handlers fire, no
publication rows are persisted, nothing downstream runs. This is the
core guarantee of the outbox pattern — "event published only if the
business change landed".

## Choosing between handler flavours

- **`@TransactionalEventsHandler`** — cheap, in-process, phase-aware,
  non-durable. Use for side effects that are OK to lose on a crash
  between commit and invocation (metrics, cache invalidation,
  enrichment of in-memory state).
- **`@OutboxEventsHandler`** *(from outbox)* — durable,
  retry-on-failure, resumable-across-restart, delivered by a worker.
  Use for integration with external systems, email sends, billing
  events, or any side effect where at-least-once delivery matters.
  Requires `OutboxModule` to be wired.
- **`@IntegrationEventsHandler`** — smart default, class-level
  composite. When the outbox registrar is bound, delivery goes
  through the outbox (durable). Without it, delivery falls back to
  the in-memory dispatcher with `AFTER_COMMIT` + `async: true` +
  fresh-transaction semantics. Matches Spring Modulith's
  `@ApplicationModuleListener` contract — "the thing you reach for by
  default when wiring cross-module listeners, so you do not have to
  revisit every call site when persistence comes online".

### Delivery guarantees at a glance

| Decorator | Persisted? | Retry on failure? | Survives process restart? | Transaction | Typical use case |
| --- | --- | --- | --- | --- | --- |
| `@TransactionalEventsHandler` | No — in-memory only | No | No | Joins the publishing transaction's lifecycle (fires at configured phase) | Cache invalidation, metrics, in-process enrichment |
| `@OutboxEventsHandler` | Yes — `event_publication` row per listener | Yes — via operator-triggered resubmit | Yes — `republishOnStartup` replays | `REQUIRES_NEW` per invocation (default) | External API calls, emails, billing events, cross-module integration where loss is unacceptable |
| `@IntegrationEventsHandler` | Yes if outbox registrar bound, No otherwise | Yes if outbox bound | Yes if outbox bound | `REQUIRES_NEW` (outbox) or `AFTER_COMMIT + async: true` inside a fresh tx (fallback) | Default choice for cross-module handlers — upgrades gracefully when the outbox comes online |

How `@IntegrationEventsHandler` routes depends on module wiring, not
on call-site configuration: write one decorator, and the same handler
runs via the in-memory path during early development and via the
durable outbox once the team is ready to stand up the worker process.
`IntegrationEventsHandlerScanner` decides at bootstrap based on
whether the `OUTBOX_LISTENER_REGISTRAR` provider is bound — so the
handler fires exactly once.

```ts
@Injectable()
@IntegrationEventsHandler(OrderPlacedEvent)
export class InventoryReservationHandler
  implements IIntegrationEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    // with outbox wired: runs from the worker, retried on failure.
    // without outbox:    runs in-memory after commit, fire-and-forget.
  }
}
```

Supply a stable `id` when the class name might change:

```ts
@IntegrationEventsHandler({
  events: [OrderPlacedEvent],
  id: 'Inventory.stable-id',
})
```

The listener id format is `${baseId}#${EventName}` where baseId
defaults to the class name — so class renames invalidate stored
publications unless `options.id` is set.

## Worked examples

- [`basic-cqrs`](../../examples/basic-cqrs) — Command + Query (auto-readonly) + AFTER_COMMIT `@TransactionalEventsHandler`, no DB.
- [`multi-datasource-cqrs`](../../examples/multi-datasource-cqrs) — `@Transactional({ dataSource })` per handler (Phase 14.3.1 Category B per-DS hook attachment).
- [`saga-pattern`](../../examples/saga-pattern), [`audit-logging`](../../examples/audit-logging) — `@TransactionalEventsHandler` + `@OutboxEventsHandler` against the same event class.
- [`e-commerce-orders`](../../examples/e-commerce-orders) — full CQRS + REST controller + outbox-driven saga + multi-DS.

Full catalogue: [examples/README.md](../../examples/README.md).

## Limitations

- Only works with **singleton** handlers. Request-scoped CQRS handlers
  are resolved per-request by `@nestjs/cqrs` via `ModuleRef.resolve(...)`,
  producing a fresh instance our bootstrap wrap has not mutated.
- Direct `eventBus.publish(...)` calls (outside of an aggregate) do NOT
  go through the transactional dispatcher — only `AggregateRoot.commit()`
  -emitted events via `mergeObjectContext` / `mergeClassContext`. If you
  need phase-aware handlers on bus-published events, publish them from
  an aggregate instead.
- `@nestjs/cqrs`'s handler-metadata constants are read via hardcoded
  string literals (`__commandHandler__`, etc.) because `@nestjs/cqrs`
  does not re-export them. See `handler-wrapper.ts` —
  [DD-002](../../docs/dd/002-no-fork-nestjs-cqrs.md) documents this
  coupling.

## Status

Work in progress. Not yet published to npm.
