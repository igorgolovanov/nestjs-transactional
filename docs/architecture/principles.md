# Architectural Principles

The principles that shape every package in the
`@nestjs-transactional` monorepo. These predate any concrete
package decision and inform the ADRs and DDs.

## 1. Hexagonal architecture (ports and adapters)

The core package defines **ports** — interfaces. Separate packages implement
**adapters** — concrete implementations. Core knows nothing about any
specific ORM.

```
@nestjs-transactional/core
└── defines: TransactionAdapter (port)
         ↑
         │ implements
         │
@nestjs-transactional/typeorm
└── TypeOrmTransactionAdapter (adapter)
```

This lets us add more adapters in the future (Prisma, Drizzle, Kysely,
MikroORM) without touching core.

## 2. Layered dependencies

Dependency layers are strict, top to bottom:

```
@nestjs-transactional/cqrs
        ↓ depends on
@nestjs-transactional/typeorm (optional — cqrs also works without typeorm)
        ↓ depends on
@nestjs-transactional/core
        ↓ depends on
NestJS platform + Node builtins
```

**Important**: core does NOT import TypeORM, typeorm does NOT import
@nestjs/cqrs. Reverse dependencies are forbidden.

## 3. AsyncLocalStorage instead of ThreadLocal

Node.js has no ThreadLocal (unlike Java). Instead we use `AsyncLocalStorage`
from `node:async_hooks`. It propagates context correctly across async
boundaries (await, promises, I/O callbacks).

This is the foundation of the whole module. All transaction-context work
goes through `TransactionContext` — a thin wrapper around AsyncLocalStorage.

See [ADR-001](../adr/001-async-local-storage.md) and
[DD-001](../dd/001-async-local-storage.md) for the foundational decision.

## 4. Spring @Transactional semantics

`@Transactional()` behavior is modeled on Spring Framework:

- **Propagation modes**: REQUIRED (default), REQUIRES_NEW, NESTED, SUPPORTS,
  NOT_SUPPORTED, NEVER, MANDATORY
- **Isolation levels**: READ_UNCOMMITTED, READ_COMMITTED, REPEATABLE_READ,
  SERIALIZABLE
- **Rollback rules**: `rollbackFor` and `noRollbackFor` for selective rollback
- **Read-only flag**: a hint for optimization
- **Timeout**: optional

Users coming from Spring should feel at home.

## 5. Spring @TransactionalEventListener for CQRS

The cqrs package ships a class-level `@TransactionalEventsHandler`
decorator, equivalent to Spring's `@TransactionalEventListener` and
modelled on `@nestjs/cqrs`'s `@EventsHandler` ergonomics:

- **BEFORE_COMMIT**: invoked before commit; an error rolls the transaction
  back
- **AFTER_COMMIT**: invoked after a successful commit (the main use case)
- **AFTER_ROLLBACK**: invoked after a rollback
- **AFTER_COMPLETION**: invoked on any completion

This solves the classic problem of "event published, but the transaction was
rolled back". With AFTER_COMMIT this cannot happen — the listener only runs
once the commit has succeeded.

Handler classes implement `ITransactionalEventHandler<T>` and expose
a single `handle(event)` method. See [ADR-002](../adr/002-transactional-events-spring-semantics.md)
and [ADR-014](../adr/014-handler-api-redesign.md) for the rationale
behind the class-level shape.

## 6. AggregateRoot integration

For DDD/CQRS projects using `AggregateRoot` from `@nestjs/cqrs`:

```typescript
const order = this.publisher.mergeObjectContext(Order.place(...));
await this.orders.save(order);
order.commit();
// events will fire in AFTER_COMMIT listeners, not immediately
```

`commit()` is retargeted by swapping `EventPublisher` for our
`TransactionalEventPublisherAdapter`. Events no longer go straight to the
in-memory EventBus — they are registered on the current transaction as
hooks for the appropriate phase.
