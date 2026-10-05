# Migrating from 2.x to 3.0

3.0.0 keeps `@Transactional` and `@Externalized` and hands outbox delivery
to the first-party [`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox).
`@nestjs-transactional/outbox` becomes a bridge that adds your event to
`@nestjs/outbox` inside the transaction `@Transactional` opened. Why:
[ADR-023](../adr/023-delegate-delivery-to-nestjs-outbox.md). The bridge's
rules: [DD-028](../dd/028-outbox-bridge-contract.md).

Two more changes ship in the same major. cqrs events now go through the
`@nestjs/cqrs` `EventBus` ([ADR-024](../adr/024-cqrs-events-through-the-event-bus.md)),
which changes the module's options and what `@EventsHandler`s receive:
see [cqrs and the EventBus](#cqrs-event-bus). And NestJS 10 leaves every
peer range.

If you use only `@nestjs-transactional/core` and `typeorm`, the upgrade
is a version bump on NestJS 11 or 12. With `cqrs` and without the
outbox, read [section 7](#cqrs-event-bus) and
[`@IntegrationEventsHandler`](#integrationeventshandler).

## What changes, at a glance

| 2.x | 3.0 |
| --- | --- |
| `@nestjs-transactional/outbox-typeorm` | `@nestjs/outbox`'s `PostgresOutboxStore` with `fromTypeOrm(dataSource)` |
| `@nestjs-transactional/outbox-microservices` | `@nestjs/outbox`'s `ClientProxyTransport`, plus `toKafkaPacket` from the bridge |
| `OutboxModule.forRoot({ repository, processor, ... })` | `@nestjs/outbox`'s `OutboxModule.forRoot({ route, relay, retry, transports })`, plus `TransactionalOutboxModule.forRoot()` |
| `OutboxModule.forFeature([Event])` | nothing: topics are strings |
| `OutboxProcessingModule` | the relay, on by default; `relay: { enabled: false }` on processes that only publish |
| `@OutboxEventsHandler({ events, id })` | `@OnOutboxMessage(topic, { consumer })` |
| `@IntegrationEventsHandler` (durable when the outbox was wired) | in-memory only; durable work moves to `@OnOutboxMessage` |
| `@Externalized({ client: Symbol })` | `client` is a string, a transport name |
| the bare event on the wire | the envelope `{ id, topic, key, headers, createdAt, payload }` |
| an outbox per DataSource (ADR-019) | one outbox DataSource |
| `event_publication`, `event_publication_archive` | the `nest_outbox` schema |
| NestJS 10, 11, 12 | NestJS 11 or 12 |
| `CqrsTransactionalModule` overrides `EventPublisher` | events go through the `EventBus`; `@EventsHandler`s and sagas receive aggregate events |
| `HybridEventPublisher`, `TransactionalEventPublisher`, `TransactionalEventPublisherAdapter` | `TransactionalEventBusPublisher`, in the bus's publisher chain |
| `useTransactionalEventPublisher` | removed |
| `TypeOrmTransactionalModule`, `CqrsTransactionalModule`, `CQRS_TRANSACTIONAL_OPTIONS` | `TransactionalTypeOrmModule`, `TransactionalCqrsModule`, `TRANSACTIONAL_CQRS_OPTIONS`; the old names are deprecated aliases |
| `@Transactional({ timeout })`, accepted and ignored | deprecated, removed in the next major ([DD-032](../dd/032-transaction-retry-and-timeout.md)); `retry` is new |
| `CqrsModule` options nowhere | `TransactionalCqrsModule.forRoot({ cqrs, eventPublisher })` |

## Renamed, with deprecated aliases

Public names now lead with `Transactional`, then the library they
integrate, the way NestJS names `WorkflowsCqrsModule`
([DD-030](../dd/030-transactional-first-names.md)):

| 2.x | 3.0 |
| --- | --- |
| `TypeOrmTransactionalModule` | `TransactionalTypeOrmModule` |
| `TypeOrmTransactionalOptions`, `TypeOrmTransactionalAsyncOptions` | `TransactionalTypeOrmOptions`, `TransactionalTypeOrmAsyncOptions` |
| `CqrsTransactionalModule` | `TransactionalCqrsModule` |
| `CqrsTransactionalOptions`, `CqrsTransactionalAsyncOptions`, `CqrsTransactionalAsyncFactoryResult` | `TransactionalCqrsOptions`, `TransactionalCqrsAsyncOptions`, `TransactionalCqrsAsyncFactoryResult` |
| `CqrsTransactionalBootstrap` | `TransactionalCqrsBootstrap` |
| `CQRS_TRANSACTIONAL_OPTIONS` | `TRANSACTIONAL_CQRS_OPTIONS` |

The old names still compile: they are the same classes and values,
marked `@deprecated`, and go in the next major. A search and replace
finishes the move. The one thing an alias cannot cover is the options
token's string value: inject `TRANSACTIONAL_CQRS_OPTIONS`, not the
literal `'CQRS_TRANSACTIONAL_OPTIONS'`.

## 1. Drain the old outbox first

The two stores do not share a table. A message still in
`event_publication` when you switch is never delivered by 3.0.

The zero-downtime way is to let a 2.x worker finish while 3.0 takes new
traffic:

1. Deploy 3.0 for the processes that publish. From here new messages go
   to `nest_outbox`.
2. Keep one 2.x worker running, the previous image with
   `OutboxProcessingModule`, until nothing is left:

   ```ts
   // in the 2.x worker
   await incomplete.count(); // 0 means drained
   await failed.findAll(); // decide: resubmit, or record and drop
   ```

   `FAILED` publications are not drained by waiting. Resubmit them while
   the 2.x worker still runs, or decide to drop them.
3. Stop the 2.x worker, then drop the old tables. 2.x's
   `revertEventPublicationSchema` does that, or drop `event_publication`
   and `event_publication_archive` in a migration of your own.

If a short pause in publishing is acceptable, the simpler way is to stop
the publishing processes, let the 2.x worker drain, then deploy 3.0
everywhere.

## 2. Dependencies

```bash
pnpm remove @nestjs-transactional/outbox-typeorm @nestjs-transactional/outbox-microservices
pnpm add @nestjs/outbox@~0.1.0
pnpm add @nestjs-transactional/core@^3 @nestjs-transactional/typeorm@^3 @nestjs-transactional/cqrs@^3 @nestjs-transactional/outbox@^3
```

`@nestjs/outbox` is pre-1.0, which is why the bridge pins `~0.1.0`. The
outbox needs NestJS 11 or 12.

## 3. Schema

`PostgresOutboxStore` creates its `nest_outbox` schema at startup outside
production. With `NODE_ENV=production` it refuses to start on an outdated
schema instead. Apply it before deploying:

```bash
npx nest-outbox migrate
```

Or take the SQL from `PostgresOutboxStore.migrationSql()` into your
migration tool. On PostgreSQL the database's default isolation level must
stay READ COMMITTED; the store checks at startup.

## 4. Module wiring

Before:

```ts
OutboxTypeOrmModule.forRoot(),
OutboxModule.forRoot({
  repository: typeOrmEventPublicationRepositoryProvider(),
  processor: { pollingInterval: 1000, batchSize: 100, maxConcurrent: 10 },
  retry: { maxAttempts: 5, baseDelay: 1000, factor: 2, maxDelay: 300_000 },
  republishOnStartup: true,
}),
OutboxModule.forFeature([OrderPlacedEvent]),
OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA' }),
OutboxProcessingModule,
```

After:

```ts
OutboxModule.forRoot({
  imports: [clients], // the ClientsModule.register(...) result
  transports: { KAFKA: ClientProxyTransport('KAFKA', { toPacket: toKafkaPacket }) },
  route: externalizedRoute({ defaultTransport: 'KAFKA' }),
  relay: { pollInterval: '1s', batchSize: 100, concurrency: 10 },
  retry: { attempts: 5, backoff: { delay: '1s', factor: 2, maxDelay: '5m' } },
}),
TransactionalOutboxModule.forRoot(),

// in providers
{
  provide: PostgresOutboxStore,
  inject: [getDataSourceToken(), OutboxStorage],
  useFactory: (dataSource: DataSource, storage: OutboxStorage) =>
    new PostgresOutboxStore({ executor: fromTypeOrm(dataSource) }, storage),
},
```

Option mapping:

| 2.x | 3.0 (`@nestjs/outbox`) |
| --- | --- |
| `processor.pollingInterval` | `relay.pollInterval` |
| `processor.batchSize` | `relay.batchSize` |
| `processor.maxConcurrent` | `relay.concurrency` |
| `processor.shutdownTimeout` | drained by `app.enableShutdownHooks()` |
| `retry.maxAttempts` | `retry.attempts`, on by default (20) |
| `retry.baseDelay`, `factor`, `maxDelay` | `retry.backoff.delay`, `factor`, `maxDelay` |
| `retry.jitter` (a fraction) | `retry.backoff.jitter`: `'equal'`, `'full'` or `'none'` |
| `staleness` | the lease: a stuck message is reclaimed once `relay.lease` expires |
| `republishOnStartup` | not needed: leases recover after a crash, on any instance |
| `cleanup`, `completionMode` | not needed: a delivered message is removed |

`OutboxEventPublisher` keeps its name and `publish(event)`. Inject it the
same way; `@InjectOutboxPublisher()` is gone along with per-DataSource
publishers.

## 5. Handlers

```ts
// 2.x
@Injectable()
@OutboxEventsHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
export class ShippingHandler implements IOutboxEventHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent) { ... }
}

// 3.0
@Injectable()
export class ShippingHandler {
  @OnOutboxMessage('OrderPlacedEvent', { consumer: 'shipping.create-shipment' })
  @Transactional() // optional: the handler's own transaction
  async createShipment(event: OrderPlacedEvent) { ... }
}
```

- **The topic.** An event without `@Externalized` is published under its
  class name. One with `@Externalized` is published under its `target`.
- **The payload is plain JSON**, not a class instance; the outbox
  serialises it when the message is added. Code that relied on
  `instanceof` or on methods of the event class needs to change. A
  handler for several events now has one method per topic, or one method
  subscribed to a list of topics.
- **`consumer` replaces the listener id.** It keys the handler's inbox,
  which skips a message the handler already completed. Keep it stable:
  renaming it makes every past message look new.
- **`@Transactional` on the handler method works.** `@nestjs/outbox`
  calls the method through the instance at delivery time, so it gets
  the transactional version.
- **One message, one transport.** In 2.x an `@Externalized` event also
  ran its local listeners. In 3.0 a message goes to one transport, so an
  event that must reach both a broker and an in-process handler is
  published twice, under two topics, or handled by the consumer side of
  the broker.

## <a id="integrationeventshandler"></a>6. `@IntegrationEventsHandler`

It is now in-memory only: after the commit, asynchronously, in its own
transaction. Its `id` option is removed, along with
`OUTBOX_LISTENER_REGISTRAR` and `OutboxListenerRegistrar`. If you relied
on it becoming durable once the outbox was wired, move the handler to
`@OnOutboxMessage`.

## <a id="cqrs-event-bus"></a>7. cqrs and the EventBus

`TransactionalCqrsModule` no longer overrides `EventPublisher`. It
imports `CqrsModule.forRoot()` with its own publisher in the `EventBus`,
so every event, from `aggregate.commit()` or `eventBus.publish()`, goes
through the bus ([DD-029](../dd/029-cqrs-publisher-chain-contract.md)).
What that changes for you:

- **`@EventsHandler`s and sagas now receive aggregate events**, at once
  and inside the transaction, as `@nestjs/cqrs` always delivered direct
  publishes. If one of them must not see an aggregate's event, move it
  to `@TransactionalEventsHandler` with the phase it needs.
- **A direct `eventBus.publish()` now schedules phase handlers** and, for
  an `@Externalized` event with the outbox wired, the outbox. Outside a
  transaction, such an `@Externalized` event is dropped and logged, as
  from `commit()`.
- **The dispatcher context.** Inside `@Transactional`, a publish without
  one, or with the aggregate, carries `{ transaction, aggregate? }`. A
  custom `IEventPublisher` that read the aggregate from the context
  finds it under `aggregate`.
- **Options.** `useTransactionalEventPublisher` is gone. Options you
  passed to `CqrsModule.forRoot()` go to
  `TransactionalCqrsModule.forRoot({ cqrs: { ... } })`, and an
  `eventPublisher` to `forRoot({ eventPublisher })`. Keep no other
  `CqrsModule` import: bootstrap now fails on a second `EventBus`.
- **`CommandBus`, `QueryBus` and `EventBus` are injectable anywhere.**
  Controllers that injected handlers directly to work around their
  absence can use the buses again.
- **Removed exports**: `HybridEventPublisher`,
  `TransactionalEventPublisher`, `TransactionalEventPublisherAdapter`,
  `AggregateConstructor`.

With `@nestjs/workflows`' `WorkflowsCqrsModule`, `@StartOn` and
`@SignalOn` on events published inside `@Transactional` now write in the
business transaction.

## 8. Aggregate events

`AggregateRoot.commit()` reaches the outbox through the cqrs publisher
(section 7), and `TransactionalOutboxModule` now binds the scheduler
port itself; remove any manual `OUTBOX_PUBLICATION_SCHEDULER` provider.

Only `@Externalized` events go to the outbox from an aggregate. The rest
stay with the in-memory dispatcher, because `@nestjs/outbox` dead-letters
a topic nobody handles. For durable in-process delivery of an aggregate's
event, route it to `@nestjs/outbox`'s `local` transport:

```ts
@Externalized<OrderPlaced>({ target: 'orders.placed', client: 'local' })
export class OrderPlaced { ... }
```

## 9. Brokers

- `@Externalized({ client })` is a string naming a transport in
  `OutboxModule`'s `transports`, conventionally the `ClientsModule` token.
  Symbol tokens no longer work.
- `externalizedRoute()` builds `route` from the decorators. A target
  without a client goes to `defaultTransport`; with neither, routing
  fails and the message dead-letters.
- `routingKey` and `headers`, accepted and dropped by 2.x, now reach the
  wire. For Kafka, pass `toKafkaPacket` so the routing key becomes the
  Kafka key and the headers become Kafka headers.
- Register `ClientsModule` in `OutboxModule.forRoot({ imports })` too:
  the transport resolves the client in `OutboxModule`'s context.

## 10. Consumers of your events

This is the change other teams see. The message is now `@nestjs/outbox`'s
envelope:

```ts
@EventPattern('orders.placed')
handle(@Payload() envelope: OutboxEnvelope<OrderPlaced>) {
  const order = envelope.payload; // was: the whole message
  // envelope.id is stable across redeliveries: deduplicate on it
}
```

Upgrade consumers to read `payload` before the producer ships 3.0, or
have them accept both shapes during the switch.

## 11. More than one DataSource

The outbox lives in one DataSource, `'default'` unless set with
`TransactionalOutboxModule.forRoot({ dataSource })`. Publishing from a
transaction on another DataSource throws. If 2.x ran an outbox per
DataSource:

- keep the outbox on the DataSource whose transactions publish, and let
  consumers on other DataSources write there in their own transactions,
  as [`audit-logging`](../../examples/audit-logging) does; or
- put the contexts that publish into one DataSource, as schemas, as
  [`e-commerce-orders`](../../examples/e-commerce-orders) does.

## 12. Operator APIs

| 2.x | 3.0 |
| --- | --- |
| `FailedEventPublications.findAll()` | `OutboxDeadLetters.list()` |
| `FailedEventPublications.resubmit()` | `OutboxDeadLetters.requeue(id \| id[])` |
| `IncompleteEventPublications.count()` | `OutboxRelay.stats()` (`pending`, `ready`, `leased`, `lagMs`) |
| `CompletedEventPublications.purge()` | not needed: delivered messages are removed |

Where 2.x left a failed publication `FAILED` for an operator, 3.0 retries
it with backoff and dead-letters it once the attempts run out. Alert on
`lagMs` and on dead letters.

## 13. Tests

`@nestjs-transactional/outbox/testing` is gone. In integration tests,
turn the relay off with `relay: { enabled: false }` and call
`OutboxRelay.runOnce()` to deliver deterministically. Without a database,
provide a recording `Outbox` and `TransactionalOutboxModule.forRoot({
transactionResolver: (active) => active.handle })` with the in-memory
adapter, which has no native transaction of its own. Atomicity can only be asserted against a real database.
[`testing-patterns`](../../examples/testing-patterns) shows all three
tiers.
