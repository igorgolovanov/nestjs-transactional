# @nestjs-transactional/outbox

[![npm version](https://img.shields.io/npm/v/%40nestjs-transactional%2Foutbox?style=flat-square&label=npm)](https://www.npmjs.com/package/@nestjs-transactional/outbox)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://github.com/igorgolovanov/nestjs-transactional/blob/main/LICENSE)

`@Transactional` for [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox):
publish an event from inside a transaction, and the outbox message
commits or rolls back with your rows. You never pass the transaction by
hand.

`@nestjs/outbox` does the delivery. It brings fenced leases, per-key
ordering, retries with a dead-letter queue, consumer inboxes and
observability. Its own API is `outbox.add(tx, message)`, which makes the
transaction a parameter of every method between your controller and
the write. This package removes that parameter. It reads the
transaction `@Transactional` opened and passes it on for you.

From 3.0.0 this package is a bridge. Releases up to 2.x shipped their
own delivery engine; [ADR-023](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
explains the change, and the [migration guide](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/guides/migrating-to-3.md)
covers the upgrade.

## Install

```bash
pnpm add @nestjs-transactional/outbox @nestjs/outbox @nestjs-transactional/core @nestjs-transactional/typeorm
```

## Wire it

`OutboxModule` and its store are configured exactly as `@nestjs/outbox`
documents them. This package adds two things: `TransactionalOutboxModule`,
and a `route` built from your `@Externalized` events.

```ts
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ClientProxyTransport, OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromTypeOrm, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import {
  externalizedRoute,
  toKafkaPacket,
  TransactionalOutboxModule,
} from '@nestjs-transactional/outbox';

@Module({
  imports: [
    TypeOrmModule.forRoot({ type: 'postgres' /* ... */ }),
    TransactionalModule.forRoot({ isGlobal: true }),
    TransactionalTypeOrmModule.forRoot(),

    ClientsModule.register([{ name: 'KAFKA', transport: Transport.KAFKA, options: {/* ... */} }]),
    OutboxModule.forRoot({
      imports: [ClientsModule],
      transports: { KAFKA: ClientProxyTransport('KAFKA', { toPacket: toKafkaPacket }) },
      route: externalizedRoute(),
    }),
    TransactionalOutboxModule.forRoot(),
  ],
  providers: [
    {
      provide: PostgresOutboxStore,
      inject: [DataSource, OutboxStorage],
      useFactory: (ds: DataSource, storage: OutboxStorage) =>
        new PostgresOutboxStore({ executor: fromTypeOrm(ds) }, storage),
    },
  ],
})
export class AppModule {}
```

## Publish

```ts
@Externalized<OrderPlaced>({
  target: 'orders.placed', // the topic
  client: 'KAFKA', // the transport that delivers it
  routingKey: (e) => e.orderId, // ordered per order; the Kafka key with toKafkaPacket
})
export class OrderPlaced {
  constructor(readonly orderId: string) {}
}

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    private readonly publisher: OutboxEventPublisher,
  ) {}

  @Transactional()
  async place(dto: PlaceOrderDto) {
    const order = await this.orders.save(dto);
    await this.publisher.publish(new OrderPlaced(order.id));
    return order; // the message commits with the order, or not at all
  }
}
```

The consumer receives `@nestjs/outbox`'s envelope: `{ id, topic, key,
headers, createdAt, payload }`. `id` is stable across redeliveries, so
it is the key to deduplicate on, for instance with `@nestjs/outbox`'s
inbox.

## Handle an event in-process

An event without `@Externalized` is published to a topic named after its
class, and `externalizedRoute()` sends it to `@nestjs/outbox`'s `local`
transport. Handle it with `@OnOutboxMessage`:

```ts
await this.publisher.publish(new StockReserved(order.id));

@Injectable()
export class ReservationEmails {
  @OnOutboxMessage('StockReserved', { consumer: 'reservation-email' })
  async send(event: { orderId: string }) {
    // retried with backoff, deduplicated per consumer, dead-lettered when exhausted
  }
}
```

The handler receives plain JSON, not a class instance: `@nestjs/outbox`
serialises the payload when the message is added.

## Rules

- **Only inside a transaction.** `publish()` outside one throws
  `IllegalTransactionStateError`, because the message could not commit
  with your writes.
- **One outbox DataSource**, `'default'` unless set with
  `TransactionalOutboxModule.forRoot({ dataSource })`. A transaction on
  any other DataSource is refused with an error that names both, never
  written outside your transaction.
- **`AggregateRoot.commit()`** reaches the outbox through
  `@nestjs-transactional/cqrs`: `@Externalized` events are added just
  before the commit. Other aggregate events stay with the in-memory
  dispatcher.
- **Any adapter with a native transaction.** The transaction handed to
  `outbox.add()` is what the adapter's `nativeTransaction` returns, for
  TypeORM the `EntityManager` `@Transactional` opened. An adapter without
  it passes a `transactionResolver`.

Everything about delivery belongs to `@nestjs/outbox`, so its
documentation is the reference: retries, dead letters, ordering, the
relay, running several instances, testing with `relay.runOnce()`, and
the production checklist.

## Documentation

- [ADR-023: why delivery moved to `@nestjs/outbox`](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/023-delegate-delivery-to-nestjs-outbox.md)
- [DD-028: the bridge contract](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/dd/028-outbox-bridge-contract.md)
- [ADR-021: what each transport acknowledges](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/021-externalization-acknowledgement-per-transport.md)

## License

MIT
