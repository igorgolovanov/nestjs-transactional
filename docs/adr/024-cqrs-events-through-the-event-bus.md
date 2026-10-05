# ADR-024: Aggregate events go through the `@nestjs/cqrs` EventBus

- **Status**: Accepted
- **Date**: 2026-10-05
- **Supersedes**: mechanism 2 of ADR-003 (the `EventPublisher` DI
  override), and decision 6 of ADR-022, which typed that override
- **Related**:
  - ADR-004 (public API stability)
  - ADR-023 (delivery through `@nestjs/outbox`)
  - DD-028 (the outbox bridge contract)
  - DD-029 (the cqrs publisher chain contract)

## Context

NestJS has published a family of reliability modules next to
`@nestjs/outbox`: `@nestjs/workflows` (durable workflows, with a
`/cqrs` entry point), `@nestjs/locks`, `@nestjs/idempotency` and
`@nestjs/resilience`. `@nestjs/cqrs` itself reached 12.1. None of them
offers an ambient transaction. The ones that write to the database take
the transaction explicitly: `outbox.add(tx, ...)`,
`workflowClient.start(..., { transaction })`, and, by the convention the
`@nestjs/cqrs` documentation now uses, `aggregate.commit({ transaction })`.

Until now `@nestjs-transactional/cqrs` replaced the `EventPublisher` DI
token with its own adapter. `mergeObjectContext` and `mergeClassContext`
overwrote `publish` and `publishAll` on the aggregate to call our
strategy directly. Checked against `@nestjs/cqrs` 12.1 and
`@nestjs/workflows` 0.0.1, that design has four defects:

1. **The dispatcher context is lost.** The overwritten methods take no
   context and return `void`. `await aggregate.commit({ transaction })`
   resolves at once, and the context never reaches a publisher.
2. **Aggregate events never reach the `EventBus`.** Plain
   `@EventsHandler`s and sagas do not see them, and neither does
   `WorkflowsCqrsModule`, which starts and signals workflows by wrapping
   `EventBus.publisher`. `@StartOn` on an aggregate event never fires.
3. **`@Publishable` aggregates (12.1) bypass the phases.** They call
   `eventBus.publish` directly, which our override did not cover.
4. **A direct `eventBus.publish` skips the phase handlers**, although the
   `fallbackExecution` documentation said otherwise.

The `EventPublisher` override also scoped `CqrsModule`'s exports to our
module, so applications could not inject `CommandBus` or `EventBus`
(convention #20).

## Decision

Events go through the `EventBus`, and our logic sits inside its
publisher chain, in two layers:

1. **The bus's publisher.** `CqrsTransactionalModule` imports
   `CqrsModule.forRoot({ eventPublisher })` itself, with a
   `TransactionalEventBusPublisher`. `EventBus` installs it in its
   constructor, so a publisher that wraps `EventBus.publisher` later,
   such as `WorkflowsCqrsModule`'s, wraps ours whatever the module
   order. For each event it schedules the phase handlers, schedules
   `@Externalized` events for the outbox, and hands the event on at once
   to `@EventsHandler`s and sagas, exactly as the default publisher would.
2. **The bus's own `publish` and `publishAll`**, wrapped on the instance.
   Inside a transaction, a publish without a dispatcher context, or with
   the aggregate that `EventPublisher` passes by default, gets
   `{ transaction, aggregate? }`, where `transaction` is the adapter's
   native transaction. A promise the chain returns is tracked by the
   transaction, so COMMIT waits for it and a rejection rolls back. That
   is the only point above `WorkflowsCqrsModule`'s publisher that does
   not depend on module order.

The adapter SPI gains an optional `nativeTransaction(handle)`, and
`TransactionManager` gains `nativeTransactionOf(active)` and
`trackPending(active, promise)`. The outbox bridge uses the same SPI, so
every bridge resolves the transaction one way.

A plain `@EventsHandler` keeps `@nestjs/cqrs`'s semantics: it runs
immediately, inside the publishing transaction, like a plain
`@EventListener` in Spring. Phases stay with
`@TransactionalEventsHandler`.

The stock `EventPublisher` stays. In 12.1 it already forwards the
dispatcher context and returns the result. In 11 it passes the
aggregate, which the second layer replaces.

## Consequences

- `@StartOn` and `@SignalOn` on events published inside `@Transactional`
  write in the business transaction, without `{ transaction }` in the
  caller's code, on `@nestjs/cqrs` 11 and 12.
- `@EventsHandler`s and sagas now receive aggregate events. In an
  application that relied on them not doing so, this is a behaviour
  change.
- Applications can inject `CommandBus`, `QueryBus` and `EventBus`
  (convention #20 retires).
- Breaking API: `TransactionalEventPublisherAdapter`,
  `AggregateConstructor`, `HybridEventPublisher`,
  `TransactionalEventPublisher` and the `useTransactionalEventPublisher`
  option are removed. `CqrsModule` options move to
  `CqrsTransactionalModule.forRoot({ cqrs })`, and an application's own
  bus publisher to `forRoot({ eventPublisher })`. Released with 3.0.0.
- We wrap a third-party instance (`EventBus.publish`). A symbol guard
  keeps the wrap single, and both `@nestjs/cqrs` 11.0.3 and 12.1 run in
  CI.
- Bootstrap fails when a second `EventBus` exists or
  `EventBus.publisher` no longer reaches ours, instead of events
  silently bypassing phases and the outbox.
- Nest 10 leaves the peer ranges of core, typeorm and cqrs. It was
  declared and never tested, and `@nestjs/outbox` and `@nestjs/cqrs` 12
  do not support it.

## Alternatives considered

- **Keep the `EventPublisher` override, and forward the context.** Fixes
  defect 1 only. Workflows would still never see `commit()`.
- **Replace `EventBus.publisher` after bootstrap.** `WorkflowsCqrsModule`
  refuses that at bootstrap, by design.
- **Deliver `@EventsHandler`s after the commit.** Safer for handlers with
  side effects, but it silently changes `@nestjs/cqrs` semantics for
  every direct `eventBus.publish` too. `@TransactionalEventsHandler`
  already offers the phase.
