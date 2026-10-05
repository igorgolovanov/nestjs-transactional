# Moving from `@TransactionalEventsHandler` to the outbox

This guide is for an application that today relies on
`@nestjs-transactional/cqrs`'s in-memory `@TransactionalEventsHandler`
and wants some of its handlers delivered durably.

Durable delivery comes from
[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox), the
first-party NestJS outbox. `@nestjs-transactional/outbox` is the bridge:
it adds your event to `@nestjs/outbox` inside the transaction
`@Transactional` opened, so you never pass a transaction by hand
([ADR-023](../adr/023-delegate-delivery-to-nestjs-outbox.md)).

Nothing breaks along the way. Every `@TransactionalEventsHandler` keeps
working; you move handlers one at a time.

Upgrading an application from 2.x, which had its own outbox engine? See
[Migrating from 2.x to 3.0](migrating-to-3.md) instead.

## What you get

- **Durable delivery.** The message commits with the business write. If
  the process dies between the commit and the handler, the relay
  delivers it after the restart, on any instance.
- **Retries and dead letters.** A failing handler is retried with
  backoff; once the attempts run out the message is dead-lettered with
  its error history, and `OutboxDeadLetters.requeue(...)` sends it again.
- **Deduplication per handler.** Each handler has an inbox, keyed by its
  `consumer` name, that skips a message it already completed.
- **Several instances.** Messages are claimed with `SKIP LOCKED` and a
  lease, so two instances never deliver the same message at once.
- **Ordering per key**, when a message carries one.
- **Brokers**, once the outbox is in place: Kafka, RabbitMQ and others
  through `@nestjs/microservices`.

## What stays the same

- `@Transactional` and everything about it: propagation, isolation, the
  transparent repositories.
- `@TransactionalEventsHandler` for handlers that should stay in memory.
- `AggregateRoot.commit()`, which publishes through the `EventBus`.

## Step 1 — install

```bash
pnpm add @nestjs-transactional/outbox @nestjs/outbox
```

## Step 2 — wire the modules

```ts
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { TransactionalOutboxModule } from '@nestjs-transactional/outbox';

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'postgres' /* ... */ }),
    TransactionalModule.forRoot({ isGlobal: true }),
    TypeOrmTransactionalModule.forRoot(),

    OutboxModule.forRoot(),
    TransactionalOutboxModule.forRoot(),
  ],
  providers: [
    {
      provide: PostgresOutboxStore,
      inject: [getDataSourceToken(), OutboxStorage],
      useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
        new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
    },
  ],
})
export class AppModule {}
```

The store creates its `nest_outbox` schema at startup outside
production. In production apply it before deploying, with
`npx nest-outbox migrate`.

## Step 3 — pick a handler per use case

### Keep `@TransactionalEventsHandler` when…

- the work is cheap, in-process and fine to lose on a crash: cache
  invalidation, metrics, logging;
- it must run before the commit (`BEFORE_COMMIT`) or on rollback
  (`AFTER_ROLLBACK`). The outbox only ever delivers after a commit.

### Move to `@OnOutboxMessage` when…

- the work talks to the outside world: email, payments, webhooks,
  another service;
- losing it on a crash or a deploy is not acceptable;
- it is slow and should not hold up the request.

## Step 4 — move a handler

Publish the event through the outbox, inside the same `@Transactional`
method as the business write:

```ts
@Transactional()
async placeOrder(dto: PlaceOrderDto) {
  const order = await this.orders.save(dto);
  await this.publisher.publish(new OrderPlacedEvent(order.id)); // OutboxEventPublisher
  return order;
}
```

Then turn the handler into an `@OnOutboxMessage` method. The topic is
the event's class name:

```ts
// before
@TransactionalEventsHandler(OrderPlacedEvent)
export class SendConfirmation implements ITransactionalEventHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent) { await this.mail.send(event); }
}

// after
@Injectable()
export class SendConfirmation {
  @OnOutboxMessage('OrderPlacedEvent', { consumer: 'orders.send-confirmation' })
  async send(event: OrderPlacedEvent) { await this.mail.send(event); }
}
```

Three differences to account for:

- **The payload is plain JSON**, not an `OrderPlacedEvent` instance.
- **Delivery is at-least-once.** The inbox skips a message the handler
  already completed, but a handler that crashes halfway through runs
  again. Make its effects idempotent, or use
  `ctx.processInTransaction(tx, work)` so the inbox record and the
  handler's writes commit together.
- **Keep `consumer` stable.** It keys the inbox; renaming it makes every
  past message look new.

### Events from an aggregate

If the event is applied by an aggregate and published by
`aggregate.commit()`, it reaches the outbox only when it carries
`@Externalized`. For in-process durable delivery, route it to
`@nestjs/outbox`'s `local` transport:

```ts
@Externalized<OrderPlacedEvent>({ target: 'orders.placed', client: 'local' })
export class OrderPlacedEvent { ... }
```

and subscribe to `'orders.placed'`.

## Step 5 — run the relay where you want it

The relay runs in every instance by default. A process that only
publishes can switch it off with `OutboxModule.forRoot({ relay: {
enabled: false } })`, and dedicated instances deliver. Call
`app.enableShutdownHooks()`, so a deploy drains the relay instead of
leaving messages leased.

## Step 6 — test it

In integration tests, turn the relay off and call
`OutboxRelay.runOnce()` to deliver exactly when the test asks:

```ts
await orders.placeOrder(dto);
await relay.runOnce();
expect(mail.sent).toHaveLength(1);
```

Assert atomicity against a real database: after a rolled-back
`placeOrder`, `nest_outbox.messages` holds nothing.
[`testing-patterns`](../../examples/testing-patterns) shows the tiers.

## More than one DataSource

The outbox lives in one DataSource, `'default'` unless set with
`TransactionalOutboxModule.forRoot({ dataSource })`. Publishing from a
transaction on another DataSource throws instead of writing outside the
transaction. A consumer may still write to another DataSource in its own
transaction; [`audit-logging`](../../examples/audit-logging) shows that
shape.

## Sending events to a broker

Annotate the event and give `@nestjs/outbox` a transport:

```ts
@Externalized<OrderPlacedEvent>({
  target: 'orders.placed',
  client: 'KAFKA',
  routingKey: (e) => e.orderId,
})
export class OrderPlacedEvent { ... }
```

```ts
OutboxModule.forRoot({
  imports: [clients], // ClientsModule.register([{ name: 'KAFKA', ... }])
  transports: { KAFKA: ClientProxyTransport('KAFKA', { toPacket: toKafkaPacket }) },
  route: externalizedRoute(),
}),
```

Consumers receive `@nestjs/outbox`'s envelope, with the event as
`payload` and a stable `id` to deduplicate on. What a broker's
acknowledgement means differs by transport; see
[ADR-021](../adr/021-externalization-acknowledgement-per-transport.md).
[`externalization-kafka`](../../examples/externalization-kafka) and
[`externalization-with-fallback`](../../examples/externalization-with-fallback)
show it end to end.

## Troubleshooting

- **`IllegalTransactionStateError` from `publish()`.** It was called
  outside a transaction, or inside one on a different DataSource than
  the outbox's. Wrap it in `@Transactional()`.
- **A message dead-letters with `OutboxNoHandlerError`.** Nothing
  subscribes to its topic. Check the handler's topic against the event's
  class name, or its `@Externalized` target.
- **An aggregate's event never reaches the outbox.** It has no
  `@Externalized`; see [Events from an aggregate](#events-from-an-aggregate).
- **The handler ran twice.** Delivery is at-least-once. See the
  idempotency note in [Step 4](#step-4--move-a-handler).

## See also

- [`basic-typeorm-outbox`](../../examples/basic-typeorm-outbox) — the
  smallest runnable version of this guide.
- [`@nestjs-transactional/outbox` README](../../packages/outbox/README.md)
- [DD-028 — the bridge contract](../dd/028-outbox-bridge-contract.md)
- [`@nestjs/outbox` documentation](https://docs.nestjs.com/reliability/outbox)
