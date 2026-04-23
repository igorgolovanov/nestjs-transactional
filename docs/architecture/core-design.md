# Core Design — Extension Points

`@nestjs-transactional/core` is intentionally thin. Three extension points
let consumers plug new behaviour in without modifying the package:

1. **`TransactionAdapter`** — add support for a new ORM or data store.
2. **`TransactionObserver`** — subscribe to transaction lifecycle events
   for metrics, tracing, audit.
3. **Transactional lifecycle hooks** — per-transaction callbacks
   registered from inside a transactional method.

This document describes the contract of each and how to wire it up.

---

## 1. TransactionAdapter

The core package defines the port; integration packages (TypeORM, Prisma,
and so on) ship the concrete adapter. To support a new data store, write
an implementation of the interface and register it via
`TransactionalModule`.

### Contract

```ts
export interface TransactionAdapter<
  THandle extends TransactionHandle = TransactionHandle,
> {
  readonly name: string;

  runInTransaction<T>(
    options: TransactionOptions,
    fn: (handle: THandle) => Promise<T>,
  ): Promise<T>;

  runInSavepoint<T>(
    parent: THandle,
    fn: (handle: THandle) => Promise<T>,
  ): Promise<T>;
}
```

- `runInTransaction` must begin a transaction, invoke `fn`, commit on
  resolve, roll back on reject. The handle passed to `fn` is the
  adapter-specific extension of `TransactionHandle` (e.g. the TypeORM
  adapter attaches an `EntityManager`).
- `runInSavepoint` runs `fn` inside a savepoint on `parent`. A savepoint
  rollback must not affect the enclosing transaction. Adapters without
  savepoint support must throw `IllegalTransactionStateError`.

All higher-level behaviour (propagation, rollback rules, observer events,
commit/rollback hooks) lives in the manager. Adapters stay minimal.

### Example skeleton

```ts
import { randomUUID } from 'node:crypto';
import type {
  TransactionAdapter,
  TransactionHandle,
  TransactionOptions,
} from '@nestjs-transactional/core';

interface MyOrmTransactionHandle extends TransactionHandle {
  readonly session: MyOrmSession;
}

export class MyOrmTransactionAdapter
  implements TransactionAdapter<MyOrmTransactionHandle>
{
  readonly name = 'my-orm';

  constructor(private readonly client: MyOrmClient) {}

  async runInTransaction<T>(
    options: TransactionOptions,
    fn: (handle: MyOrmTransactionHandle) => Promise<T>,
  ): Promise<T> {
    return this.client.transaction(options, async (session) => {
      const handle: MyOrmTransactionHandle = {
        id: randomUUID(),
        adapterName: this.name,
        session,
      };
      return fn(handle);
    });
  }

  async runInSavepoint<T>(
    parent: MyOrmTransactionHandle,
    fn: (handle: MyOrmTransactionHandle) => Promise<T>,
  ): Promise<T> {
    return parent.session.savepoint(async (sub) => {
      const handle: MyOrmTransactionHandle = {
        id: randomUUID(),
        adapterName: this.name,
        session: sub,
      };
      return fn(handle);
    });
  }
}
```

### Registration

```ts
TransactionalModule.forRoot({
  adapters: [
    {
      adapterName: 'my-orm',
      instanceName: 'default',
      adapter: new MyOrmTransactionAdapter(client),
    },
  ],
})
```

---

## 2. TransactionObserver

Observer is a **monitoring** hook: subscribe to transaction lifecycle
events without influencing their outcome. Typical use cases — metrics
export, distributed tracing, structured audit logs.

### Contract

```ts
export interface TransactionObserver {
  onTransactionStart?(ctx: TransactionStartContext): void;
  onTransactionCommit?(ctx: TransactionCommitContext): void;
  onTransactionRollback?(ctx: TransactionRollbackContext): void;
}
```

All methods are optional — implement only what you need.

- `onTransactionStart` fires once the adapter has produced a transaction
  handle and the manager has registered the active transaction on the
  context. Fires before the user's `fn` runs.
- `onTransactionCommit` fires after the adapter commits, **before** the
  `afterCommitHooks` run. `durationMs` is wall-clock time since start;
  `commitCount` is the number of hooks that are about to execute.
- `onTransactionRollback` fires after the adapter rolls back, **before**
  the `afterRollbackHooks` run. Receives the error that caused the
  rollback.

Errors thrown from observer methods are caught and logged via the NestJS
Logger — they do **not** change the transaction outcome, and they do not
prevent sibling observers from running.

### Example

```ts
import type {
  TransactionCommitContext,
  TransactionObserver,
  TransactionRollbackContext,
} from '@nestjs-transactional/core';

@Injectable()
export class TransactionMetricsObserver implements TransactionObserver {
  constructor(private readonly metrics: MetricsService) {}

  onTransactionCommit(ctx: TransactionCommitContext): void {
    this.metrics.histogram('tx.duration_ms', ctx.durationMs, {
      adapter: ctx.adapterName,
      instance: ctx.adapterInstanceName,
      outcome: 'commit',
    });
  }

  onTransactionRollback(ctx: TransactionRollbackContext): void {
    this.metrics.histogram('tx.duration_ms', ctx.durationMs, {
      adapter: ctx.adapterName,
      instance: ctx.adapterInstanceName,
      outcome: 'rollback',
    });
  }
}
```

### Registration

Static registration (observer instances):

```ts
TransactionalModule.forRoot({
  observers: [new SimpleLoggingObserver()],
})
```

DI-resolved registration (observer depends on other providers):

```ts
@Module({
  imports: [
    TransactionalModule.forRoot({
      adapters: [...],
      // Do NOT set `observers` here.
    }),
  ],
  providers: [
    TransactionMetricsObserver,
    {
      provide: TRANSACTION_OBSERVERS,
      useFactory: (o: TransactionMetricsObserver) => [o],
      inject: [TransactionMetricsObserver],
    },
  ],
})
export class AppModule {}
```

Provide `TRANSACTION_OBSERVERS` either through the module option *or*
through a custom provider, not both — NestJS rejects duplicate providers.

---

## 3. Transactional lifecycle hooks

Hooks are **in-flight** callbacks registered from inside a transactional
method, bound to that specific transaction. They are the right tool when
you want to react to a transaction outcome within the same unit of work —
e.g. enqueue a domain event that must not be sent on rollback.

### API

```ts
manager.registerBeforeCommit(async () => { /* ... */ });
manager.registerAfterCommit(async () => { /* ... */ });
manager.registerAfterRollback(async (error: unknown) => { /* ... */ });
```

- `registerBeforeCommit` — runs inside the adapter callback, before the
  commit. A throwing hook triggers the adapter's rollback path.
- `registerAfterCommit` — runs after the adapter commits. Hook errors
  are swallowed and logged; the transaction has already committed.
- `registerAfterRollback` — runs after the adapter rolls back. Receives
  the causal error. Hook errors are swallowed and logged.

All three throw `IllegalTransactionStateError` when called outside an
active transaction.

For `NESTED` propagation, hooks register on the **outer** transaction —
events "promote" to the enclosing unit of work and fire on its
commit/rollback.

### Example

```ts
@Injectable()
export class OrderService {
  constructor(private readonly manager: TransactionManager) {}

  @Transactional()
  async placeOrder(payload: PlaceOrderDto) {
    const order = await this.orders.insert(payload);

    this.manager.registerAfterCommit(async () => {
      await this.bus.publish(new OrderPlaced(order.id));
    });

    return order;
  }
}
```

### Hook vs observer — when to pick which

| Use case | Hook | Observer |
| --- | --- | --- |
| Emit domain event tied to THIS transaction | ✅ | ❌ |
| Track tx duration histogram | ❌ | ✅ |
| Roll back on pre-commit validation | ✅ `registerBeforeCommit` | ❌ |
| Audit log every tx with outcome | ❌ | ✅ |
| Correlation id propagation | read via `TransactionContext.getStore()` | read via context ctx |

Hooks see state of the current request; observers see state of every
transaction. Hooks can influence flow (`beforeCommit` rollback);
observers cannot.
