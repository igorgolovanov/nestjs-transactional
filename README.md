# @nestjs-transactional

[![CI](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml/badge.svg)](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node: 20+](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org)
[![TypeScript: 5.5+](https://img.shields.io/badge/typescript-5.5+-blue)](https://www.typescriptlang.org/)

**Spring Modulith-equivalent transactional + event-delivery
infrastructure for NestJS.** Declarative `@Transactional` with
every propagation mode, multi-datasource support, phase-aware
event listeners that integrate with `@nestjs/cqrs`
`AggregateRoot`, and a durable Event Publication Registry with
retry, recovery, and at-least-once delivery semantics.

## Packages

| Package | npm | Purpose |
| --- | --- | --- |
| [`@nestjs-transactional/core`](packages/core) | [![npm](https://img.shields.io/npm/v/@nestjs-transactional/core.svg)](https://www.npmjs.com/package/@nestjs-transactional/core) | AsyncLocalStorage context, `TransactionManager`, `@Transactional` decorator, adapter port |
| [`@nestjs-transactional/typeorm`](packages/typeorm) | [![npm](https://img.shields.io/npm/v/@nestjs-transactional/typeorm.svg)](https://www.npmjs.com/package/@nestjs-transactional/typeorm) | TypeORM adapter, `getCurrentEntityManager`, multi-datasource support |
| [`@nestjs-transactional/cqrs`](packages/cqrs) | [![npm](https://img.shields.io/npm/v/@nestjs-transactional/cqrs.svg)](https://www.npmjs.com/package/@nestjs-transactional/cqrs) | `@nestjs/cqrs` integration: handler wrapping, `@TransactionalEventsHandler`, `@IntegrationEventsHandler`, aggregate events |
| [`@nestjs-transactional/outbox`](packages/outbox) | *(unreleased, alpha)* | Persistent Event Publication Registry — lifecycle states, async worker, staleness monitor, startup recovery, operator APIs, `@Externalized` SPI |
| [`@nestjs-transactional/outbox-typeorm`](packages/outbox-typeorm) | *(unreleased, alpha)* | TypeORM persistence backend for the outbox — `event_publication` table, `FOR UPDATE SKIP LOCKED`, migration, dev-time auto-init |
| [`@nestjs-transactional/outbox-microservices`](packages/outbox-microservices) | *(unreleased, alpha)* | Event externalization to message brokers via `@nestjs/microservices` `ClientProxy` (Kafka, RabbitMQ, NATS, JMS, gRPC, custom) — Spring Modulith `@Externalized` parity |

## Why?

NestJS apps that talk to a database quickly grow a thicket of
`dataSource.transaction(async em => ...)` blocks, repositories
that thread `EntityManager` as an argument, and "is this event
fired after the write is durable, or only if it is?" doubt.
Spring solved that decades ago — this library brings the same
ergonomics:

```ts
@Injectable()
export class OrderService {
  @Transactional()
  async placeOrder(orderId: string): Promise<void> {
    const em = getCurrentEntityManager('default');
    await em.save(OrderRow, { id: orderId, status: 'placed' });
    // No more passing the EntityManager around — every repository in
    // this call tree automatically joins the same transaction.
  }
}
```

- **All seven Spring propagation modes**: `REQUIRED` (default),
  `REQUIRES_NEW`, `NESTED` (savepoints), `SUPPORTS`,
  `NOT_SUPPORTED`, `NEVER`, `MANDATORY`.
- **Rollback rules** via `rollbackFor` / `noRollbackFor`.
- **Multi-datasource** as a first-class feature —
  `@Transactional({ adapterInstance: 'billing' })`.
- **Phase-aware class-level event handlers** via
  `@TransactionalEventsHandler`: `BEFORE_COMMIT`, `AFTER_COMMIT`,
  `AFTER_ROLLBACK`, `AFTER_COMPLETION`. Matches `@nestjs/cqrs`
  conventions — see ADR-014.
- **AggregateRoot integration** — `order.commit()` attaches
  events as hooks on the current transaction; no more "event
  published, transaction rolled back" races.
- **Durable event delivery via the outbox pattern** — event
  publications commit atomically with business writes; a
  background worker delivers them at-least-once with automatic
  retry, staleness detection, and startup recovery.
- **`@IntegrationEventsHandler` as smart default** —
  Spring-Modulith-equivalent class-level decorator. Durable via
  the outbox when wired, in-memory fallback otherwise. Same
  source code, two delivery modes, chosen by module wiring.

## Quick start

### Transactions only (TypeORM)

```bash
pnpm add @nestjs-transactional/core @nestjs-transactional/typeorm
```

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

@Module({
  imports: [
    TypeOrmModule.forRoot({ /* your TypeORM config */ }),
    TypeOrmModule.forFeature([OrderRow]),

    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot(),
  ],
  providers: [OrderService],
})
export class AppModule {}
```

```ts
// order.service.ts — Phase 14.20 transparent transactional Repositories.
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(OrderRow)
    private readonly orderRepo: Repository<OrderRow>,
  ) {}

  @Transactional()
  async placeOrder(id: string): Promise<void> {
    // `orderRepo.save(...)` automatically dispatches through the
    // active transaction — no `getCurrentEntityManager` boilerplate.
    await this.orderRepo.save({ id, status: 'placed' });
  }
}
```

### Full stack with CQRS and the outbox

```bash
pnpm add @nestjs-transactional/core \
         @nestjs-transactional/typeorm \
         @nestjs-transactional/cqrs \
         @nestjs-transactional/outbox \
         @nestjs-transactional/outbox-typeorm
```

```ts
@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot(),
    OutboxTypeOrmModule.forFeature({ dataSource }),
    OutboxModule.forRoot({
      repository: typeOrmEventPublicationRepositoryProvider,
      republishOnStartup: true,
    }),
    // Each feature module imports OutboxModule.forFeature([...]) for the
    // event classes it owns — matches TypeOrmModule.forFeature() ergonomics.
    OutboxModule.forFeature([OrderPlacedEvent]),
    OutboxProcessingModule, // worker processes only
    CqrsModule.forRoot(),
    CqrsTransactionalModule.forRoot(),
  ],
  providers: [
    { provide: OUTBOX_PUBLICATION_SCHEDULER, useExisting: OutboxEventPublisher },
    PlaceOrderHandler,
    InventoryHandlers,
  ],
})
export class AppModule {}
```

```ts
@Injectable()
@IntegrationEventsHandler(OrderPlacedEvent)
export class InventoryReservationHandler
  implements IIntegrationEventHandler<OrderPlacedEvent>
{
  async handle(event: OrderPlacedEvent): Promise<void> {
    // Durable. Runs in its own REQUIRES_NEW transaction after
    // the publishing tx commits. Retries on failure. Resumes
    // after a process restart.
  }
}
```

## Roadmap

| Phase | Status | Scope |
| --- | --- | --- |
| 0 — Monorepo setup | ✅ done | pnpm workspaces, TypeScript project refs, Jest, ESLint, Prettier, Changesets, CI |
| 1 — `@nestjs-transactional/core` | ✅ done | Context, manager, propagation modes, decorator, interceptor, methods bootstrap, observability |
| 2 — `@nestjs-transactional/typeorm` | ✅ done | Adapter, `getCurrentEntityManager`, multi-datasource, savepoints |
| 3 — `@nestjs-transactional/cqrs` | ✅ done | Phase-aware dispatching, handler wrapping, `TransactionalEventPublisher`, `AggregateRoot` integration |
| 4 — Examples & CI | ✅ done | Three runnable examples, GitHub Actions, coverage reports |
| 5 — `@nestjs-transactional/outbox` | ✅ done (alpha) | Types, SPI, registry, publisher, processor, staleness monitor, startup recovery, operator APIs, in-memory repo, NestJS modules |
| 6 — `@nestjs-transactional/outbox-typeorm` | ✅ done (alpha) | Entity, repository, migration, `SchemaInitializer`, `OutboxTypeOrmModule` |
| 7 — CQRS ↔ outbox integration | ✅ done (alpha) | `HybridEventPublisher`, `@IntegrationEventsHandler`, `IntegrationEventsHandlerScanner` with outbox/in-memory routing |
| 8 — Testing utilities | ✅ done (alpha) | `PublishedEvents`, `AssertablePublishedEvents` in `/testing` subpath |
| 9 — Documentation & release | 🟡 in progress | Architecture docs, ADRs, migration guide, full-stack example, first 0.x release |
| 10 — Class-level handler API + naming refinement | ✅ done | Method-level → class-level migration (ADR-014); second pass renamed `@ApplicationModuleHandler` → `@IntegrationEventsHandler` |
| 11 — Event externalization | 🟡 in progress | `EventExternalizer` SPI, `@Externalized` decorator, `outbox-microservices` package, ADR-015, ADR-016 (reliability semantics) |
| *(future)* | 🗓 not scheduled | Broker-aware externalizers (native `kafkajs` / `amqplib` / `nats` under the same SPI for stricter delivery — see ADR-016), outbox-prisma, outbox-mongodb, OpenTelemetry, ESM dual packaging |

## Examples

A Tier 1–5 example library lives under [`examples/`](examples/) —
see [`examples/README.md`](examples/README.md) for the full
catalogue and the "Picking the right starting point" decision
guide. Quick anchors:

- **Tier 1 — Foundational**: [`basic-transactional`](examples/basic-transactional),
  [`basic-outbox`](examples/basic-outbox),
  [`basic-typeorm-outbox`](examples/basic-typeorm-outbox),
  [`basic-cqrs`](examples/basic-cqrs).
- **Tier 2 — Multi-DataSource**: [`multi-datasource-basic`](examples/multi-datasource-basic),
  [`multi-datasource-outbox`](examples/multi-datasource-outbox),
  [`multi-datasource-cqrs`](examples/multi-datasource-cqrs),
  [`shared-database-modular-monolith`](examples/shared-database-modular-monolith).
- **Tier 3 — Externalization**: [`externalization-kafka`](examples/externalization-kafka),
  [`externalization-multi-broker`](examples/externalization-multi-broker),
  [`externalization-multi-datasource`](examples/externalization-multi-datasource),
  [`externalization-with-fallback`](examples/externalization-with-fallback).
- **Tier 4 — Advanced patterns**: [`saga-pattern`](examples/saga-pattern),
  [`audit-logging`](examples/audit-logging),
  [`read-write-separation`](examples/read-write-separation),
  [`testing-patterns`](examples/testing-patterns).
- **Tier 5 — Production realism**: [`e-commerce-orders`](examples/e-commerce-orders),
  [`async-config-from-environment`](examples/async-config-from-environment),
  [`graceful-shutdown`](examples/graceful-shutdown).

```bash
pnpm -C examples/basic-transactional start
```

## Documentation

- **Per-package READMEs**: [`core`](packages/core/README.md),
  [`typeorm`](packages/typeorm/README.md),
  [`cqrs`](packages/cqrs/README.md),
  [`outbox`](packages/outbox/README.md),
  [`outbox-typeorm`](packages/outbox-typeorm/README.md),
  [`outbox-microservices`](packages/outbox-microservices/README.md).
- **Architecture overview**:
  - [`docs/architecture/core-design.md`](docs/architecture/core-design.md) — core transaction infrastructure.
  - [`docs/architecture/outbox-pattern.md`](docs/architecture/outbox-pattern.md) — the outbox pattern, lifecycle, performance.
  - [`docs/architecture/outbox-integration-with-cqrs.md`](docs/architecture/outbox-integration-with-cqrs.md) — `HybridEventPublisher`, `@IntegrationEventsHandler`, handler flavours.
  - [`docs/architecture/event-externalization.md`](docs/architecture/event-externalization.md) — `@Externalized` flow, sequence diagram, failure modes, reliability semantics.
- **Architecture Decision Records**: [`docs/adr/`](docs/adr/) —
  ADR-005 (method wrapping), ADR-006 (outbox rationale),
  ADR-007 (outbox architecture), ADR-014 (class-level handler API),
  ADR-015 (event externalization architecture),
  ADR-016 (externalization reliability semantics).
- **Guides**: [`docs/guides/migrating-to-outbox.md`](docs/guides/migrating-to-outbox.md)
  — step-by-step migration from
  `@TransactionalEventsHandler` to durable delivery.
- **Repository conventions** and PR workflow:
  [`CONTRIBUTING.md`](CONTRIBUTING.md). The implementation
  roadmap and per-phase retrospectives live in
  [`docs/roadmap/`](docs/roadmap/) and
  [`docs/status/`](docs/status/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev-environment
setup, testing, commit message style, and the changeset
workflow.

## License

MIT — see [LICENSE](LICENSE).
