# DD-028: The outbox bridge contract

**Context**: ADR-023 replaces the outbox engine with `@nestjs/outbox` and
keeps `@Transactional` and `@Externalized`. The two meet in a small
bridge, `@nestjs-transactional/outbox`. This record fixes what the
bridge does, because every rule below is observable by an application
and therefore public API under ADR-004.

**Decision**:

1. **Which transaction.** The bridge is bound to one DataSource
   (`'default'` unless configured). `publish()` reads
   `TransactionContext.getActiveTransactionByDataSource(name)` and hands
   the transaction to `outbox.add()`:
   - with no active transaction, it throws `IllegalTransactionStateError`;
   - with a transaction active only on another DataSource, the error
     names both. A write that silently escaped the business transaction
     is the one outcome an outbox must never produce.
2. **How the handle becomes `outbox.add()`'s `tx`.** A
   `transactionResolver(active)` option. The default asks the adapter,
   through `TransactionManager.nativeTransactionOf(active)` and the
   optional `TransactionAdapter.nativeTransaction` SPI method, for its
   ORM's transaction object; the TypeORM adapter returns the transactional
   `EntityManager`. The package therefore still peers only on `core`. An
   adapter without the method gets a clear error, and a resolver can
   always be passed instead. Every bridge in this repository resolves
   the transaction the same way.
3. **The message.**
   - `topic` is `@Externalized({ target })` when present, otherwise the
     event's class name. An event without `@Externalized` is therefore
     still durable: it goes to topic `ClassName`, which
     `@OnOutboxMessage('ClassName', …)` handles locally. This is the
     migration path for 2.x's `@OutboxEventsHandler`.
   - `payload` is the event. `@nestjs/outbox` serialises it to JSON on
     `add()`, so handlers and consumers receive plain data, not a class
     instance.
   - `key` is `routingKey(event)` when the decorator has one. That gives
     per-key ordering in the relay, and, through a packet builder, a
     Kafka message key.
   - `headers` are the decorator's resolved headers, plus `x-event-type`
     with the class name.
   - `id` is left to `@nestjs/outbox` (UUIDv7). It is the deduplication
     key consumers see in the envelope.
4. **Latency.** `outbox.notify()` runs from the transaction's
   after-commit hooks, so the relay wakes immediately and not on its
   next poll. Never before the commit, which would wake it to find
   nothing.
5. **The AggregateRoot path.** `scheduleForPublication(event)` is
   synchronous, because `AggregateRoot.commit()` is. Events are buffered
   per active transaction and written by one before-commit hook, the
   same buffering 2.x used, so the messages still commit or roll back
   with the transaction. Only `@Externalized` events are scheduled. The
   rest stay with the in-memory dispatcher, as before.

   Scheduling every aggregate event was rejected on measurement:
   `@nestjs/outbox`'s `local` transport throws `OutboxNoHandlerError`
   for a topic nobody subscribes to, so each event without a durable
   subscriber would retry and then dead-letter. An aggregate event that
   does need durable in-process delivery opts in with
   `@Externalized({ target, client: 'local' })`, which routes it to the
   `local` transport and its `@OnOutboxMessage` handlers. The
   `e-commerce-orders` example starts its saga that way.
6. **Routing.** `@Externalized({ client })` names a `@nestjs/outbox`
   transport and is now a `string`, since transport names are strings.
   The decorator records `target → client` at decoration time, and two
   events declaring one target with different clients fail there, not
   at runtime. `externalizedRoute({ defaultTransport, fallback })` turns
   that table into `OutboxModule`'s `route`:
   - a target with a client goes to that client;
   - a target without one goes to `defaultTransport`. With no
     `defaultTransport`, routing throws and the message dead-letters,
     rather than being delivered by guess;
   - any other topic goes to `fallback`, `'local'` by default.
7. **Transport records.** `ClientProxyTransport` emits the envelope as
   is. For Kafka, `toKafkaPacket` is passed as its `toPacket`: the
   message key becomes the Kafka key, the headers become Kafka headers
   with the outbox id added as `x-outbox-id`, and the value stays the
   whole envelope. RabbitMQ needs no builder, because the envelope
   already carries the id, key and headers. A wrapper that built the
   whole `transports` map was considered and dropped: it would have
   repeated `ClientProxyTransport` and added nothing beyond the
   `toPacket` function.
8. **What the application still configures itself.** `OutboxModule`,
   the store and the relay options are `@nestjs/outbox`'s, configured
   as its documentation shows. The bridge only adds the publisher and
   the two helpers. Hiding their module behind ours would pin every one
   of its options to our release cycle.

**Rationale**: every rule exists to keep one property: an outbox message
is written in the business transaction or not at all, with nothing
passed by hand. The rest (topic defaults, routing helpers, packet
builders) is the shortest path from 2.x's decorators to
`@nestjs/outbox`'s model, without a second abstraction over it.

**Verified by** the bridge's integration suite against PostgreSQL. It
covers commit and rollback, `REQUIRES_NEW` and `NESTED`,
`SERIALIZABLE`, delivery through `ClientProxyTransport`, refusal outside
a transaction, and, for `toKafkaPacket`, a message read back from a real
Kafka broker with its key and headers.
