# ADR-023: Delegate outbox delivery to `@nestjs/outbox`, keep the programming model

- **Status**: Accepted
- **Date**: 2026-10-05
- **Supersedes** (the delivery-engine parts of): ADR-006, ADR-007,
  ADR-015, ADR-019; DD-016, DD-019, DD-024, DD-025, DD-026
- **Related**:
  - ADR-004 (public API stability: a breaking change needs a major and an ADR)
  - ADR-021 (what `ClientProxy.emit()` acknowledges, per transport; still valid)
  - DD-028 (the bridge contract)

## Context

Until now this repository shipped its own transactional outbox: an
Event Publication Registry modelled on Spring Modulith, a polling
processor, staleness and startup recovery, retry and cleanup
schedulers, a TypeORM store and a `ClientProxy` externalizer, across
`outbox`, `outbox-typeorm` and `outbox-microservices`.

NestJS has since published a first-party outbox, `@nestjs/outbox`
(0.1.0, documented under Reliability on docs.nestjs.com). A
side-by-side comparison of the two showed that its delivery engine is
ahead of ours on every axis that concerns delivery itself:

| | `@nestjs/outbox` 0.1.0 | our engine (2.x) |
| --- | --- | --- |
| Claim | `SKIP LOCKED`, a lease, and a fencing token checked by every later write | an unlocked read, then a conditional `UPDATE`; writes after the claim are unconditional |
| Recovery after a crash | the lease expires and another instance takes over | staleness monitor (off by default), or `republishOnStartup`, which resubmits rows a live sibling is still processing |
| Ordering | per key, in commit order | none |
| Consumer side | an inbox; `processInTransaction` gives exactly-once writes to the consumer's own database | nothing |
| On the wire | an envelope with a stable message `id`, `key` and `headers`; `toPacket` maps to transport records | the bare event; `routingKey` and `headers` are accepted by `@Externalized` and dropped |
| Fan-out | one message, one destination | one row per listener, so an externalized event is emitted once per listener, and never when it has none |
| Retry | on by default, with backoff, jitter, `retryIf` and a non-retryable error | opt-in |
| Per-attempt timeout | `publishTimeout` with an `AbortSignal` | none |
| Observability | `OutboxEvents`, `stats()` with `lagMs`, `diagnostics_channel` | none |
| Drivers | Drizzle, TypeORM, Prisma, Kysely, `pg`, `mysql2`; PostgreSQL and MySQL | TypeORM; PostgreSQL in CI |

Several of our rows are defects rather than missing features. The
unfenced writes and the multi-instance behaviour of
`republishOnStartup` mean a final status can be wrong and deliveries
repeated. The dropped `routingKey` means no Kafka partition key, so no
ordering even on the broker. Fixing them means rebuilding, in our
repository, what the first-party package already has.

What it does not have is our programming model. `outbox.add(tx, msg)`
needs the transaction passed in by hand, which is exactly the problem
`@Transactional` exists to remove: the transaction becomes a parameter
on every method between the controller and the write. NestJS's own
documentation has no page on declarative transactions at all.

## Decision

**Keep `@Transactional` and `@Externalized`. Replace the delivery
engine with `@nestjs/outbox`, and turn `@nestjs-transactional/outbox`
into a thin bridge that calls `outbox.add()` with the ambient
transaction.** The bridge contract is DD-028.

1. **The engine goes.** That covers the registry, processor, recovery,
   retry and cleanup schedulers, operator APIs, serializer, the
   repository SPI and the `/testing` utilities. `outbox-typeorm` and
   `outbox-microservices` are deleted: storage is `@nestjs/outbox`'s
   store, and brokers are reached through its `ClientProxyTransport`.
2. **Local durable handlers go too.** `@OutboxEventsHandler` is
   removed, and `@IntegrationEventsHandler` keeps only its in-memory
   `AFTER_COMMIT` behaviour. Durable in-process work is written with
   `@nestjs/outbox`'s `@OnOutboxMessage`, which comes with an inbox.
   Keeping our decorators would have meant applying theirs
   programmatically and depending on how they scan.
3. **The wire format becomes `OutboxEnvelope`.** Consumers get a
   stable `id` to deduplicate on and can use `@nestjs/outbox`'s inbox.
   This breaks existing consumers: the event moves to
   `envelope.payload`.
4. **One outbox DataSource.** `@nestjs/outbox` accepts one store per
   application. Publishing from a transaction on any other DataSource
   is an error, never a write that is quietly outside the business
   transaction. The multi-DataSource outbox of ADR-019 is withdrawn.
5. **Released as 3.0.0.** The cohort drops from six packages to four.
   NestJS 10 support ends, because `@nestjs/outbox` peers on
   `^11 || ^12`.
6. **New peer dependency: `@nestjs/outbox`, pinned `~0.1.0`.** It is
   pre-1.0, so a minor may break it. The range widens only after each
   release has been checked against the bridge's integration suite.

## Evidence that the bridge is viable

Before deciding, a spike ran `@nestjs/outbox` with `PostgresOutboxStore`
and `fromTypeOrm(dataSource)` against a real PostgreSQL, adding
messages through `getCurrentEntityManager()` inside `@Transactional`
methods:

- a commit persists both the business row and the message; a rollback
  persists neither;
- `REQUIRES_NEW` inside an outer transaction that rolls back keeps the
  inner message and drops the outer one, exactly like the business rows;
- a `NESTED` savepoint that rolls back drops its message while the outer
  transaction commits its own;
- `isolation: 'SERIALIZABLE'` works;
- `relay.runOnce()` delivers the envelope through `ClientProxyTransport`;
- `add()` with `dataSource.manager`, outside a transaction, is refused.

The reason it works is that store-kit's TypeORM executor accepts any
`EntityManager` whose `queryRunner.isTransactionActive`, and that is
precisely the manager `@Transactional` opens. The spike is kept as the
bridge's integration suite (DD-028).

## Consequences

- The defects listed in the context disappear with the code that had
  them, rather than being fixed one by one. That includes the unfenced
  writes, the startup resubmission race, the dropped routing key, and
  the per-listener emits.
- The Spring Modulith parity claim for the Event Publication Registry is
  withdrawn. The operator APIs map onto `OutboxDeadLetters` and
  `OutboxRelay.stats()`, but the lifecycle states, completion modes and
  audit trail of delivered events do not survive.
- ADR-021's measurements stay valid. `@nestjs/outbox`'s documentation
  reached the same per-transport conclusion independently.
- Upgrading needs a drain. The 2.x worker must finish every incomplete
  publication before 3.0 starts, because the two stores do not share a
  table. The migration guide covers it.
- 2.x enters security-fix-only maintenance. The fencing defect is
  recorded there and is not back-ported as a redesign.

## Alternatives considered

- **Fix our engine.** Fencing, ordering, an inbox, an envelope, transport
  records and observability amount to the package NestJS already
  publishes, maintained by two parties instead of one. Rejected.
- **Keep both engines behind a switch.** Twice the surface under ADR-004
  for one feature, and the defects would remain in the default.
  Rejected.
- **Wrap their decorators to keep ours.** It would preserve
  `@OutboxEventsHandler`, at the cost of depending on `@nestjs/outbox`'s
  internal scanning, in a pre-1.0 package. Rejected; point 2.
