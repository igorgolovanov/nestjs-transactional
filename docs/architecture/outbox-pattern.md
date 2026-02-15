# Outbox Pattern

`@nestjs-transactional/outbox-core` (and its TypeORM backend
`@nestjs-transactional/outbox-typeorm`) implements the
**Transactional Outbox** pattern: event publications are persisted
atomically with the business data inside the same database
transaction, then delivered asynchronously by a worker process.
The pattern is the foundation for reliable event-driven integration
between modules in a monolith and between services in a distributed
system.

## The problem

Consider a command handler that writes to a database and then
publishes a domain event to trigger downstream work:

```ts
@Transactional()
async placeOrder(cmd: PlaceOrder): Promise<void> {
  await this.orders.save(new Order(cmd.orderId));
  await this.emailer.sendConfirmation(cmd.customerEmail);   // (1)
  this.eventBus.publish(new OrderPlacedEvent(cmd.orderId)); // (2)
}
```

Three failure modes break the "either everything happens or nothing
does" contract users expect from `@Transactional`:

1. The `save` commits, the process crashes before line (1) runs. The
   order exists but the email never goes out.
2. The `save` and `sendConfirmation` both succeed; the process
   crashes before (2) runs. Downstream services never hear about the
   order.
3. (2) runs successfully but the transaction rolls back afterwards
   (unlikely with `AFTER_COMMIT` semantics, trivially common with
   naïve in-memory event buses). Downstream services react to an
   order that never got saved.

The in-memory phase-aware `@TransactionalEventsListener`
(`packages/cqrs`) already solves (3). It still cannot solve (1) or
(2) — nothing in-memory survives a crash.

## The pattern

The outbox pattern decouples "the event exists" from "the event has
been delivered":

1. **Write phase** — the publishing transaction writes both the
   business row(s) AND one row per listener into an
   `event_publication` table. Both writes commit together (or not
   at all). The event is now durable.

2. **Dispatch phase** — an asynchronous worker polls the
   `event_publication` table, claims rows atomically
   (`FOR UPDATE SKIP LOCKED`), invokes the corresponding listener,
   and marks the row `COMPLETED` on success or `FAILED` on error.
   A failed row can be retried; a lost worker leaves the row in
   `PROCESSING`, which the staleness monitor flips back so another
   worker picks it up.

The result is **at-least-once delivery with transactional
atomicity**: every committed publication is delivered eventually,
and no listener runs for a publication whose transaction rolled
back.

## Architecture

```
 ┌─────────────────────────────────────┐
 │            Nest application         │
 │                                     │
 │  ┌─────────────────────────┐        │
 │  │  @Transactional method  │        │
 │  │  writes business row    │        │
 │  │  + outbox.publish(evt)  │        │
 │  └────────────┬────────────┘        │
 │               │                     │
 │               ▼                     │
 │  ┌─────────────────────────┐        │     Postgres
 │  │ EventPublicationRegistry│ ──────────▶ ┌──────────────────┐
 │  │   .publish()            │        │   │ event_publication│
 │  │                         │        │   │ (row per listener)│
 │  └─────────────────────────┘        │   └──────────────────┘
 │                                     │        ▲
 │  Worker process                     │        │
 │  ┌─────────────────────────┐        │        │
 │  │EventPublicationProcessor│        │        │ FOR UPDATE
 │  │  - polls `PUBLISHED`    │  ◀─────┼────────┘  SKIP LOCKED
 │  │  - tryClaim()           │        │
 │  │  - invokes listener     │        │
 │  │  - marks COMPLETED      │        │
 │  └─────────────────────────┘        │
 │                                     │
 │  ┌─────────────────────────┐        │
 │  │     StalenessMonitor    │   ◀────┤  non-terminal rows
 │  │  flips stuck PROCESSING │        │  older than threshold
 │  │  back to FAILED         │        │
 │  └─────────────────────────┘        │
 │                                     │
 │  ┌─────────────────────────┐        │
 │  │  StartupRecoveryService │   ◀────┤  every incomplete row
 │  │  on bootstrap, moves    │        │  → RESUBMITTED on
 │  │  incompletes →          │        │  startup
 │  │    RESUBMITTED          │        │
 │  └─────────────────────────┘        │
 └─────────────────────────────────────┘
```

The publishing application and the worker can run in the same
process (monolith) or in separate ones (API host + background
worker). The only shared contract is the database table.

## Lifecycle states

Every `event_publication` row moves through a finite state machine:

```
                   ┌────────────┐
                   │  PUBLISHED │  initial state after publish
                   └─────┬──────┘
                         │  tryClaim (worker picks up)
                         ▼
                   ┌────────────┐                  ┌────────────┐
                   │ PROCESSING │◀─────tryClaim────│RESUBMITTED │
                   └──┬─────────┘                  └──────┬─────┘
     listener success │      │ listener throws           ▲
                      ▼      ▼                           │ operator
                 ┌─────────┐ ┌────────┐   operator resubmit
                 │COMPLETED│ │ FAILED │───────────────────┘
                 └─────────┘ └────────┘
```

- **PUBLISHED** — row committed by the publishing transaction.
  Visible to the worker's next `findReadyForProcessing` poll.
- **PROCESSING** — the worker has atomically claimed the row
  (via `tryClaim`) and is invoking the listener.
- **COMPLETED** — listener returned successfully. Row is either
  kept (`UPDATE` completion mode), deleted (`DELETE`), or moved to
  an archive table (`ARCHIVE`).
- **FAILED** — listener threw; `failure_reason` holds the message.
  Candidate for operator-driven resubmission.
- **RESUBMITTED** — operator or startup recovery has moved a
  non-terminal row back into the queue for another attempt.

Transition rules are enforced by `EventPublicationRegistry`:
`tryClaim` only transitions `PUBLISHED`/`RESUBMITTED` →
`PROCESSING`; `markCompleted` only from `PROCESSING`; and so on.

## Comparison with Spring Modulith

Spring Modulith's Event Publication Registry is the direct
inspiration for this package. The feature set maps one-to-one:

| Spring Modulith | `@nestjs-transactional/outbox-*` |
| --- | --- |
| `EventPublicationRegistry` | `EventPublicationRegistry` |
| `@ApplicationModuleListener` | `@ApplicationModuleListener` (cqrs) |
| `EventPublicationRepository` SPI | `EventPublicationRepository` SPI |
| JDBC persistence module | `outbox-typeorm` |
| `CompletedEventPublications` | `CompletedEventPublications` |
| `FailedEventPublications` (+ resubmit) | `FailedEventPublications` |
| `IncompleteEventPublications` (+ resubmit) | `IncompleteEventPublications` |
| Staleness detection (`processing` threshold) | `StalenessMonitor` |
| Republish on restart | `StartupRecoveryService` |
| Completion modes: UPDATE / DELETE / ARCHIVE | same three modes |
| `PublishedEvents` + `AssertablePublishedEvents` | same utilities, same API shape |
| `schema-initialization.enabled` | `SchemaInitializer` + `schemaInitialization: { enabled }` |

The deliberate deviations are Node-ecosystem fits rather than
semantic changes:

- `AsyncLocalStorage` instead of `ThreadLocal` for the
  transaction context (Node has no threads).
- Async workers with `setTimeout` polling instead of a thread
  pool (Node's event loop handles concurrency differently).
- NestJS DI conventions — `@Injectable()`, `useFactory`,
  `@Module({})` — instead of Spring's component-scan annotations.
- `Symbol` DI tokens for injection points.

## Performance considerations

**Write phase.** The business transaction now includes N extra
`INSERT`s into `event_publication` (N = number of listeners for the
event). Postgres handles this cheaply — a few dozen additional
inserts per tx is negligible. The index on `(status,
publication_date)` is the hot-path index for the worker, so its
maintenance cost is the one to watch. For append-heavy workloads
the cost is typically sub-millisecond per publication.

**Dispatch phase.** The worker polls at a configurable interval
(`processor.pollingInterval`, default 1 second) and reads up to
`batchSize` rows (default 100) with `FOR UPDATE SKIP LOCKED`. Each
claim is one `UPDATE` with a conditional `WHERE`; the listener
invocation is what dominates wall-clock. Up to `maxConcurrent`
invocations run in parallel per batch (default 10) via `Promise.all`.
Scaling up horizontally means running more worker processes —
`SKIP LOCKED` ensures they do not fight over the same rows.

**Cleanup.** `CompletedEventPublications.purge(olderThan)` deletes
rows in bulk with a single `DELETE ... WHERE completion_date < ?`
against the `(completion_date)` index. Archive mode (`ARCHIVE`)
moves completed rows to `event_publication_archive` so the hot
table stays small; the archive table is audit-only and does not
back worker polls.

**Latency.** End-to-end latency (from `publish()` to listener
invocation) is dominated by the polling interval. Tune down for
interactivity (100 ms), up for throughput (5 s). A future iteration
may support `LISTEN/NOTIFY`-based push delivery to eliminate the
poll entirely.

## When to use, when not to

### Reach for the outbox when…

- …the listener integrates with **external systems**: email, SMS,
  webhooks, third-party APIs, message brokers. At-least-once
  delivery is the minimum bar and the outbox provides it for free.
- …you need **delivery across a deploy or a crash**. In-memory
  dispatchers lose events on process restart; the outbox survives.
- …the listener runs in a **separate worker process** from the
  publisher. The outbox is the transport.
- …the listener's work is **expensive or slow** and you do not want
  to block the publishing request. The outbox decouples.
- …you want **operator-level replay and recovery tools** out of the
  box — `FailedEventPublications.resubmit()`,
  `IncompleteEventPublications`, etc.

### Keep `@TransactionalEventsListener` instead when…

- …the listener is **in-process, cheap, idempotent on re-runs**,
  and the side effect is **safe to lose** on a crash between
  commit and invocation. Examples: cache invalidation, metrics
  increment, logging.
- …the listener must run **inside or right before the same
  transaction** (`BEFORE_COMMIT` phase). The outbox always runs
  after the transaction commits.
- …you are writing a **library or internal plugin** where installing
  a Postgres table would be surprising to the user.

### Use `@ApplicationModuleListener` as the default…

- …for most **cross-module cross-boundary** integration listeners
  in a NestJS application. The decorator picks the right path
  automatically: durable via outbox when the outbox is wired, in-
  memory fallback otherwise. Upgrading from "no outbox" to "outbox"
  requires a module-wiring change, not a decorator change.

## See also

- [ADR-006 — Outbox pattern rationale](../adr/006-outbox-pattern.md)
- [ADR-007 — Outbox architecture (core + typeorm split)](../adr/007-outbox-architecture.md)
- [Outbox integration with CQRS](outbox-integration-with-cqrs.md)
- [Migration guide](../guides/migrating-to-outbox.md)
- [`@nestjs-transactional/outbox-core` README](../../packages/outbox-core/README.md)
- [`@nestjs-transactional/outbox-typeorm` README](../../packages/outbox-typeorm/README.md)
- [Spring Modulith — Event Publication Registry](https://docs.spring.io/spring-modulith/reference/events.html)
