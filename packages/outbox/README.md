# @nestjs-transactional/outbox

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox/alpha?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

The transactional outbox for NestJS — a persistent Event Publication
Registry, modelled on Spring Modulith's.

In-process event handlers have one failure mode you cannot design
around: if the process dies between the commit and the handler, the
event is gone. This package writes one row per handler per event, in the
same transaction as your business data. A worker picks the rows up
afterwards, retries what fails, and resumes what a restart interrupted.

Either both happen or neither does. That is the whole point.

This package is storage-agnostic — it ships the SPI, the worker, the
operator APIs and an in-memory implementation for tests, but no
production backend. Add
[`@nestjs-transactional/outbox-typeorm`](https://www.npmjs.com/package/@nestjs-transactional/outbox-typeorm)
for that. It builds on
[`@nestjs-transactional/core`](https://www.npmjs.com/package/@nestjs-transactional/core),
integrates with
[`@nestjs-transactional/cqrs`](https://www.npmjs.com/package/@nestjs-transactional/cqrs),
and can forward events to a broker through
[`@nestjs-transactional/outbox-microservices`](https://www.npmjs.com/package/@nestjs-transactional/outbox-microservices).

> **Alpha.** The public API is stable in intent but may still change
> before `1.0.0`.

## Install

```bash
pnpm add @nestjs-transactional/outbox @nestjs-transactional/core
pnpm add @nestjs-transactional/outbox-typeorm   # a persistence backend
```

## Quick start

```ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox';
import { typeOrmEventPublicationRepositoryProvider } from '@nestjs-transactional/outbox-typeorm';

@Module({
  imports: [
    // Must be global: outbox providers resolve TransactionManager
    // across module boundaries.
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot(),
    OutboxTypeOrmModule.forRoot(),

    OutboxModule.forRoot({
      // Without this, the in-memory repository stays installed and
      // nothing is ever persisted. See the note below.
      repository: typeOrmEventPublicationRepositoryProvider(),
      republishOnStartup: true,
    }),

    // Event classes this module owns. Feature modules normally call
    // forFeature for their own events.
    OutboxModule.forFeature([OrderPlacedEvent]),

    // ONLY in worker processes. An API that merely publishes events
    // must not import this.
    OutboxProcessingModule,
  ],
})
export class AppModule {}
```

> **Pass `repository`.** `OutboxModule.forRoot()` falls back to
> `InMemoryEventPublicationRepository` when the option is missing. Your
> application starts, publishes, and handles events perfectly — and
> loses every one of them on restart, with nothing in the database and
> no error anywhere.

Declare a handler:

```ts
@Injectable()
@OutboxEventsHandler(OrderPlacedEvent)
export class ChargeCustomer implements IOutboxEventHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent) {
    // Invoked by the worker, in its own transaction. Throwing marks the
    // publication FAILED, leaving it for retry or an operator.
    await this.payments.charge(event.orderId);
  }
}
```

Publish from inside a transaction:

```ts
@Transactional()
async placeOrder(dto: PlaceOrderDto) {
  const order = await this.orders.save(dto);
  await this.publisher.publish(new OrderPlacedEvent(order.id));
  return order; // publication rows commit with the order, or not at all
}
```

## Lifecycle

A publication moves through five states:

`PUBLISHED` → `PROCESSING` → `COMPLETED`, or `FAILED` → `RESUBMITTED`
back to `PROCESSING`.

The worker polls for ready rows and then **claims** each one with a
single conditional `UPDATE`. That claim, not the poll, is what makes
concurrent workers safe: two workers may fetch the same row, but only
one wins the claim and the loser moves on without invoking the handler.
So scaling out costs a wasted read, never a duplicate dispatch
([DD-025](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/025-claim-atomicity-obligation.md)).

Completed rows can be kept (`UPDATE`, the default), deleted, or moved to
an archive table — `completionMode`. Kept rows need purging eventually;
`CompletedEventPublications.purge(olderThan)` does it.

## Operating it

```ts
OutboxModule.forRoot({
  repository: typeOrmEventPublicationRepositoryProvider(),
  republishOnStartup: true,
  processor: {
    pollingInterval: 1000, // end-to-end latency is dominated by this
    batchSize: 100,
    maxConcurrent: 10,
    // How long shutdown waits for an in-flight batch. Keep it under
    // your platform's grace period; 0 disables the wait.
    shutdownTimeout: 10_000,
  },
  // Flip publications stuck in a non-terminal state to FAILED. 0 = off.
  staleness: { processing: 60_000, monitorInterval: 30_000 },
  // Automatic retry, off unless you ask for it. maxAttempts counts the
  // first delivery, so 3 means the original plus two retries.
  retry: { maxAttempts: 3, baseDelay: 1_000, factor: 2, maxDelay: 300_000 },
});
```

Shutdown is drained, not cut off: `OutboxProcessingModule` awaits the
batch already running before NestJS tears down the DataSource, so a
publication is not stranded mid-transition.

Retry is opt-in because Spring Modulith has none either — recovery is
otherwise an operator action. A publication that exhausts its attempts
stays `FAILED`; there is no separate dead-letter state, and it remains
visible and resubmittable
([DD-026](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/026-automatic-retry-policy.md)).

Three injectable APIs for operators, matching Spring Modulith's:

```ts
await failed.findAll({ minAge: 60_000 }); // triage
await failed.resubmit({ maxAttempts: 5 }); // retry by hand
await incomplete.count(); // anything not COMPLETED
await completed.purge(olderThan); // retention
```

## Listener ids

Each publication row is keyed by `${baseId}#${EventName}`, where
`baseId` defaults to the handler's class name. Renaming the class
therefore orphans any stored publication for it. Pass an explicit id
when that is a risk:

```ts
@OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'Billing.charge' })
```

## Testing

The `/testing` subpath ships an in-memory repository and fluent
assertions, so outbox behaviour is testable without a database:

```ts
import {
  AssertablePublishedEvents,
  InMemoryEventPublicationRepository,
} from '@nestjs-transactional/outbox/testing';

(await assertable.contains(OrderPlacedEvent))
  .matching((e) => e.orderId, 'o-1')
  .hasSize(1);

// The negative path matters just as much: after a rollback, the
// in-memory repository has removed the publication.
await assertable.doesNotContain(OrderCancelledEvent);
```

## Sending events to a broker

`@Externalized` marks an event for forwarding after its local handlers
complete. The `EVENT_EXTERNALIZER` SPI is transport-agnostic;
`outbox-microservices` implements it over `@nestjs/microservices`.
**Read that package's reliability note before relying on it in
production** — `ClientProxy.emit()` cannot report broker-side failure,
so a publication can be marked `COMPLETED` when nothing reached the
broker
([ADR-016](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/016-externalization-reliability-semantics.md)).

## Documentation

- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)
- [Architecture: the outbox pattern](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/architecture/outbox-pattern.md)
- [Migrating to the outbox](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/guides/migrating-to-outbox.md)
- [One `forRoot` per dataSource (ADR-019)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/019-outbox-multi-forroot-pattern.md)
- Runnable examples:
  [`basic-outbox`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/basic-outbox),
  [`saga-pattern`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/saga-pattern),
  [`audit-logging`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/audit-logging),
  [`graceful-shutdown`](https://github.com/igorgolovanov/nestjs-transactional/tree/main/examples/graceful-shutdown)

## License

MIT
