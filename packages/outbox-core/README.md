# @nestjs-transactional/outbox-core

Persistent Event Publication Registry for NestJS — an ORM-agnostic core
that brings Spring Modulith-equivalent delivery guarantees to the
`@nestjs-transactional` family of packages.

## Overview

`@TransactionalEventsListener` from `@nestjs-transactional/cqrs` provides
phase-based dispatching (like Spring Framework core): listeners fire
`AFTER_COMMIT`, `BEFORE_COMMIT`, `AFTER_ROLLBACK`, or `AFTER_COMPLETION`.
That covers a lot, but it is purely in-memory — if the process dies
between commit and listener invocation, the event is lost.

`outbox-core` closes that gap. It gives you:

- A persistent **Event Publication Registry** — every listener
  invocation is logged atomically with the business transaction.
- **Retry on process restart** — publications that were not acknowledged
  before shutdown are replayed on next startup.
- **Lifecycle states**: `PUBLISHED`, `PROCESSING`, `COMPLETED`, `FAILED`,
  `RESUBMITTED`.
- **Staleness monitor** — detects publications stuck in `PROCESSING`.
- **Failed / Incomplete / Completed** query APIs for operators.
- **Completion modes**: `UPDATE`, `DELETE`, `ARCHIVE`.

This package only defines types, the repository SPI, the in-memory
reference implementation (for tests), and the Nest module wiring. It
does **not** ship a production persistence backend — that lives in a
sibling package such as `@nestjs-transactional/outbox-typeorm`.

## Installation

```bash
pnpm add @nestjs-transactional/core @nestjs-transactional/outbox-core
# plus a persistence backend, e.g.:
pnpm add @nestjs-transactional/outbox-typeorm
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `reflect-metadata`,
`rxjs`.

## Usage

### 1. Module wiring

```typescript
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { OutboxModule, OutboxProcessingModule } from '@nestjs-transactional/outbox-core';

@Module({
  imports: [
    // isGlobal: true is REQUIRED so outbox-core providers can see
    // TransactionManager across module boundaries.
    TransactionalModule.forRoot({
      isGlobal: true,
      adapters: [/* your adapter registrations */],
    }),
    OutboxModule.forRoot({
      eventTypes: [OrderPlacedEvent, OrderShippedEvent],
      republishOnStartup: true,
      processor: { pollingInterval: 1000, batchSize: 100 },
      staleness: { processing: 60_000, monitorInterval: 30_000 },
      // repository: { provide: EVENT_PUBLICATION_REPOSITORY, useClass: TypeOrmEventPublicationRepository },
    }),
    // Import OutboxProcessingModule ONLY in worker processes — not in
    // API-only apps that merely publish events.
    OutboxProcessingModule,
  ],
})
export class AppModule {}
```

### 2. Declaring a listener

```typescript
import { Injectable } from '@nestjs/common';
import { OutboxEventListener } from '@nestjs-transactional/outbox-core';

@Injectable()
export class InventoryHandlers {
  @OutboxEventListener(OrderPlacedEvent)
  async reserveStock(event: OrderPlacedEvent): Promise<void> {
    // Runs inside a fresh REQUIRES_NEW transaction, only after the
    // publishing transaction has committed. Retried on exception,
    // resumable across restarts.
  }
}
```

### 3. Publishing events

```typescript
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { OutboxEventPublisher } from '@nestjs-transactional/outbox-core';

@Injectable()
export class PlaceOrderHandler {
  constructor(private readonly outbox: OutboxEventPublisher) {}

  @Transactional()
  async handle(command: PlaceOrder): Promise<void> {
    // ...persist business data in the same transaction...
    await this.outbox.publish(new OrderPlacedEvent(command.orderId));
  }
}
```

### 4. Operator APIs

```typescript
const failed = await this.failedEventPublications.findAll();
await this.failedEventPublications.resubmit(
  ResubmissionOptions.defaults().withBatchSize(50).withMaxAttempts(3),
);
await this.completedEventPublications.purge(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
```

## Status

**Alpha / in development.** This package is being built iteratively as
part of Phase 5 of the monorepo roadmap. The public API is not yet
stable and will change between 0.x releases.

Tracking issue and design notes: see the repository root `CLAUDE.md`
and `docs/adr/006-outbox-pattern.md` (to be created).

## Inspired by Spring Modulith

The design follows
[Spring Modulith's Event Publication Registry](https://docs.spring.io/spring-modulith/reference/events.html)
closely — lifecycle states, `@ApplicationModuleListener` semantics,
completion modes, and staleness monitoring all map one-to-one. The
deviations from Spring Modulith are limited to what is needed to fit
the Node.js / NestJS runtime (async workers instead of thread pools,
AsyncLocalStorage for transaction context, NestJS DI conventions).

## License

MIT
