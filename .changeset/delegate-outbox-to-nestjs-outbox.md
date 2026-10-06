---
'@nestjs-transactional/core': major
'@nestjs-transactional/typeorm': major
'@nestjs-transactional/cqrs': major
'@nestjs-transactional/outbox': major
---

The outbox delivers through `@nestjs/outbox`

`@Transactional` and `@Externalized` stay. The outbox's own delivery
engine is replaced by `@nestjs/outbox`, the first-party NestJS outbox,
and `@nestjs-transactional/outbox` becomes a bridge: it adds your event
to `@nestjs/outbox` inside the transaction `@Transactional` opened, so
the message commits or rolls back with your rows and nothing passes the
transaction by hand. Why, and what was weighed: ADR-023. The bridge
contract: DD-028.

Upgrading needs a drain and a schema switch. Follow the migration guide,
`docs/guides/migrating-to-3.md`, before deploying.

### Breaking

- **`@nestjs-transactional/outbox-typeorm` and
  `@nestjs-transactional/outbox-microservices` are discontinued.** Their
  last release is 2.0.0. Storage is `@nestjs/outbox`'s store
  (`PostgresOutboxStore` with `fromTypeOrm`), and brokers are reached
  through its `ClientProxyTransport`.
- **`@nestjs-transactional/outbox` is a bridge.** It keeps
  `@Externalized` and `OutboxEventPublisher`, and adds
  `TransactionalOutboxModule`, `externalizedRoute()` and
  `toKafkaPacket()`. Everything else is removed: `OutboxModule`,
  `OutboxProcessingModule`, `@OutboxEventsHandler`, the
  Failed/Incomplete/Completed publication APIs, the staleness, retry,
  cleanup and startup-recovery schedulers, the serializer, the
  repository SPI and the `/testing` entry point. `@nestjs/outbox`
  provides their counterparts: `@OnOutboxMessage`, `OutboxDeadLetters`,
  `OutboxRelay.stats()` and its own retry and lease recovery.
- **Peer dependency `@nestjs/outbox ~0.1.0`** on
  `@nestjs-transactional/outbox`, and NestJS 11 or 12 for that package,
  since `@nestjs/outbox` does not support 10.
- **The message on the wire is `@nestjs/outbox`'s envelope**,
  `{ id, topic, key, headers, createdAt, payload }`. A consumer that read
  the event as the whole message now reads `envelope.payload`, and gains
  a stable `id` to deduplicate on.
- **`@Externalized({ client })` is a string**, the name of a
  `@nestjs/outbox` transport. `routingKey` and `headers`, which 2.x
  accepted and never put on the wire, now become the message key and
  headers.
- **One outbox DataSource.** Publishing from a transaction on another
  DataSource throws instead of writing outside your transaction. The
  multi-DataSource outbox of ADR-019 is withdrawn.
- **`@IntegrationEventsHandler` is in-memory only**: after the commit,
  asynchronously, in its own transaction. Its `id` option is removed,
  along with `OUTBOX_LISTENER_REGISTRAR` and `OutboxListenerRegistrar`.
  Durable in-process work moves to `@OnOutboxMessage`.
- **`core` and `typeorm`** change nothing themselves. They move to
  3.0.0 because the packages version as one.
