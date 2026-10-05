# @nestjs-transactional/workflows

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Fworkflows?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/workflows)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

`@Transactional` for [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows):
start or signal a durable workflow from inside a transaction, and the
instance or the signal commits or rolls back with your rows. You never
pass the transaction by hand.

`@nestjs/workflows` runs the workflows: steps that survive a crash,
durable timers, signals, compensation, child workflows. A workflow
instance is a row in your database, so starting one can join the
transaction that saves the order. Its own API does that with an option,
`start(workflow, input, { transaction })`, which makes the transaction
a parameter of every method between your controller and the call. This
package removes that parameter.

## Install

```bash
pnpm add @nestjs-transactional/workflows @nestjs/workflows @nestjs-transactional/core @nestjs-transactional/typeorm
```

## Wire it

`WorkflowsModule` and its store are configured exactly as
`@nestjs/workflows` documents them. This package adds one module.

```ts
import { WorkflowsModule, WorkflowStorage } from '@nestjs/workflows';
import { fromTypeOrm, PostgresWorkflowStore } from '@nestjs/workflows/postgres';
import { TransactionalWorkflowsModule } from '@nestjs-transactional/workflows';

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'postgres' /* ... */ }),
    TransactionalModule.forRoot({ isGlobal: true }),
    TransactionalTypeOrmModule.forRoot(),

    WorkflowsModule.forRoot(),
    TransactionalWorkflowsModule.forRoot(),
  ],
  providers: [
    {
      provide: PostgresWorkflowStore,
      inject: [DataSource, WorkflowStorage],
      useFactory: (dataSource: DataSource, storage: WorkflowStorage) =>
        new PostgresWorkflowStore({ executor: fromTypeOrm(dataSource) }, storage),
    },
    OrderFulfilmentWorkflow,
  ],
})
export class AppModule {}
```

## Use it

```ts
@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly workflows: WorkflowClient,
  ) {}

  @Transactional()
  async place(dto: PlaceOrderDto): Promise<Order> {
    const order = await this.orders.save(dto);
    // No { transaction }: the instance commits with the order, or not at all.
    await this.workflows.start(OrderFulfilmentWorkflow, order, { id: `order-${order.id}` });
    return order;
  }
}
```

`signal()` works the same way. A webhook can update the order and wake
its workflow in one transaction.

## With CQRS

`@nestjs/workflows/cqrs` starts and signals workflows from events, with
`@StartOn` and `@SignalOn`. Inside `@Transactional`, those writes join
the transaction too:

```ts
@StartOn(OrderPlacedEvent, { id: (e) => `order-${e.orderId}` })
@Workflow('order-fulfilment')
export class OrderFulfilmentWorkflow implements WorkflowRunner<OrderPlacedEvent, void> { ... }
```

An aggregate's `commit()` inside a command handler then starts the
workflow in the command's transaction. That works with
[`@nestjs-transactional/cqrs`](https://www.npmjs.com/package/@nestjs-transactional/cqrs),
which also hands the transaction to the event bus, and with stock
`CqrsModule`, because this package wraps the client that
`WorkflowsCqrsModule` calls.

## What it does, exactly

- `WorkflowClient.start()` and `signal()` are wrapped on the client
  instance. A call without a `transaction` option, inside a transaction
  on the configured DataSource (`'default'` unless `forRoot({ dataSource })`
  says otherwise), gets that transaction.
- A call that passes `transaction` itself is left alone, and so is a call
  outside a transaction.
- COMMIT waits for a start or signal that nobody awaited, and a failed
  one rolls the transaction back.
- `startAndWait()` still creates its instance on its own. It waits for
  the result, and an instance created in your transaction would not
  exist until that transaction commits.
- To start a workflow outside the surrounding transaction, call it from
  a method with `@Transactional({ propagation: NOT_SUPPORTED })`.

## Isolation

On PostgreSQL, `@nestjs/workflows` needs READ COMMITTED to send a signal
inside a transaction: under a stricter level, the signal's wake-ups
could miss waits committed after the transaction's snapshot. A
`signal()` inside `@Transactional({ isolation: 'SERIALIZABLE' })` or
`'REPEATABLE_READ'` therefore fails with `WorkflowIsolationError` before
anything is written. `start()` works under any level.

## Limits

- **One DataSource.** Workflows join transactions on one DataSource, the
  one the workflow store runs on.
- **An adapter with a native transaction.** The transaction handed to
  `@nestjs/workflows` is what the adapter's `nativeTransaction` returns,
  for TypeORM the `EntityManager` `@Transactional` opened. An adapter
  without it passes a `transactionResolver`.
- **`@nestjs/workflows` is pre-1.0**, so this package pins `~0.0.1`.

## Documentation

- [DD-031, the bridge contract](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/031-workflows-bridge-contract.md)
- [`@nestjs/workflows`](https://docs.nestjs.com/reliability/workflows)
- [Getting started and full docs](https://github.com/igorgolovanov/nestjs-transactional#readme)

## License

MIT
