# @nestjs-transactional

[![CI](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml/badge.svg)](https://github.com/igorgolovanov/nestjs-transactional/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node: 20+](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen)](https://nodejs.org)
[![TypeScript: 5.5+](https://img.shields.io/badge/typescript-5.5+-blue)](https://www.typescriptlang.org/)

**Spring Framework-style declarative transaction management for NestJS.**
`@Transactional`, every propagation mode, multi-datasource support, and
phase-aware event listeners that integrate with `@nestjs/cqrs`
`AggregateRoot`.

## Packages

| Package                                             | npm                                                                                                                                   | Purpose                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`@nestjs-transactional/core`](packages/core)       | [![npm](https://img.shields.io/npm/v/@nestjs-transactional/core.svg)](https://www.npmjs.com/package/@nestjs-transactional/core)       | AsyncLocalStorage context, `TransactionManager`, `@Transactional` decorator, adapter port      |
| [`@nestjs-transactional/typeorm`](packages/typeorm) | [![npm](https://img.shields.io/npm/v/@nestjs-transactional/typeorm.svg)](https://www.npmjs.com/package/@nestjs-transactional/typeorm) | TypeORM adapter, `getCurrentEntityManager`, multi-datasource support                           |
| [`@nestjs-transactional/cqrs`](packages/cqrs)       | [![npm](https://img.shields.io/npm/v/@nestjs-transactional/cqrs.svg)](https://www.npmjs.com/package/@nestjs-transactional/cqrs)       | `@nestjs/cqrs` integration: handler wrapping, `@TransactionalEventsListener`, aggregate events |

## Why?

NestJS apps that talk to a database quickly grow a thicket of
`dataSource.transaction(async em => ...)` blocks, repositories that
thread `EntityManager` as an argument, and "is this event fired after
the write is durable, or only if it is?" doubt. Spring solved that
decades ago — this library brings the same ergonomics:

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
  `REQUIRES_NEW`, `NESTED` (savepoints), `SUPPORTS`, `NOT_SUPPORTED`,
  `NEVER`, `MANDATORY`.
- **Rollback rules** via `rollbackFor` / `noRollbackFor`.
- **Multi-datasource** as a first-class feature —
  `@Transactional({ adapterInstance: 'billing' })`.
- **Phase-aware event listeners** via `@TransactionalEventsListener`:
  `BEFORE_COMMIT`, `AFTER_COMMIT`, `AFTER_ROLLBACK`, `AFTER_COMPLETION`.
- **AggregateRoot integration** — `order.commit()` attaches events as
  `AFTER_COMMIT` hooks; no more "event published, transaction rolled
  back" races.
- **Three coordinated wrapping mechanisms** (see ADR-005):
  `TransactionalInterceptor` for request-boundary handlers,
  `TransactionalMethodsBootstrap` for plain `@Injectable` services,
  `CqrsHandlerWrapper` for CQRS handlers.

## Quick start

For a TypeORM-backed application:

```bash
pnpm add @nestjs-transactional/core @nestjs-transactional/typeorm
```

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';

@Module({
  imports: [
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forFeature({ dataSource: myDataSource }),
  ],
  providers: [OrderService],
})
export class AppModule {}
```

```ts
// order.service.ts
import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';

@Injectable()
export class OrderService {
  @Transactional()
  async placeOrder(id: string): Promise<void> {
    const em = getCurrentEntityManager('default');
    await em.save(OrderRow, { id, status: 'placed' });
  }
}
```

Add `@nestjs-transactional/cqrs` on top for phase-aware event listeners
and AggregateRoot integration — see
[`packages/cqrs/README.md`](packages/cqrs/README.md).

## Examples

Three self-contained runnable examples under [`examples/`](examples/):

- [`examples/basic-usage`](examples/basic-usage) — one `@Transactional`
  service, commit and rollback shown.
- [`examples/multi-datasource`](examples/multi-datasource) —
  `@Transactional` routing to two independent DataSources.
- [`examples/cqrs-full-stack`](examples/cqrs-full-stack) — full flow:
  aggregate → command handler → `AFTER_COMMIT` listener →
  `AFTER_ROLLBACK` listener.

```bash
pnpm -C examples/basic-usage start
```

## Documentation

- Per-package READMEs: [`core`](packages/core/README.md),
  [`typeorm`](packages/typeorm/README.md),
  [`cqrs`](packages/cqrs/README.md).
- Architecture overview: [`docs/architecture/core-design.md`](docs/architecture/core-design.md).
- Architecture Decision Records: [`docs/adr/`](docs/adr/).
- Repository conventions and onboarding notes: [`CLAUDE.md`](CLAUDE.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for dev-environment setup,
testing, commit message style, and the changeset workflow.

## License

MIT — see [LICENSE](LICENSE).
