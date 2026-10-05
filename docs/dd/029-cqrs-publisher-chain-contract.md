# DD-029: The cqrs publisher chain contract

**Context**: ADR-024 routes events through `@nestjs/cqrs`'s `EventBus`
and places our logic in its publisher chain. Every rule below is
observable by an application and is therefore public API under ADR-004.

**Decision**:

1. **The chain.** From the caller inwards:
   `EventBus.publish` (our wrap) → any publisher that wrapped
   `EventBus.publisher` (for instance `WorkflowsCqrsModule`'s) →
   `TransactionalEventBusPublisher` → the application's
   `eventPublisher` if it passed one, otherwise in-memory delivery to
   `@EventsHandler`s and sagas.
2. **The dispatcher context.** Inside a transaction on
   `eventsDataSource` (`'default'` unless configured), a publish with no
   context gets `{ transaction }`, and a publish whose context is an
   aggregate (it has `getUncommittedEvents`) gets
   `{ transaction, aggregate }`. `transaction` is
   `TransactionManager.nativeTransactionOf(active)`, for TypeORM the
   transactional `EntityManager`. A context the caller chose is passed
   through untouched. Outside a transaction, or with an adapter that has
   no native transaction, nothing changes.
3. **Pending work.** Inside such a transaction, a promise returned by
   the chain, or an array of them, is tracked with
   `TransactionManager.trackPending`. COMMIT waits for it, and a
   rejection rolls the transaction back with that error. This is what
   keeps `@nestjs/cqrs` 11's `commit()`, which drops the promise, inside
   the transaction.
4. **Per event, `TransactionalEventBusPublisher`**, in this order:
   - schedules `@TransactionalEventsHandler` and
     `@IntegrationEventsHandler` listeners for their phase;
   - calls `OUTBOX_PUBLICATION_SCHEDULER.scheduleForPublication(event)`
     when the outbox bridge is wired, which takes `@Externalized` events
     only (DD-028);
   - hands the event on, with both contexts, and returns the result.
   `publishAll` does this event by event, in order.
5. **Every route counts.** `AggregateRoot.commit()`, `apply()` with
   `autoCommit`, `@Publishable` aggregates and a direct
   `eventBus.publish()` all pass through the chain. A direct publish
   therefore also schedules phase handlers and, for an `@Externalized`
   event, the outbox.
6. **`@EventsHandler` timing.** Unchanged from `@nestjs/cqrs`:
   synchronously on publish, inside the publishing transaction. A
   command a saga dispatches joins it through `REQUIRED`. When a wrapping
   publisher forwards asynchronously (`WorkflowsCqrsModule` does for
   routed events), handlers run when it forwards, still inside the
   transaction, by point 3.
7. **Bootstrap checks.** Startup fails if more than one `EventBus`
   instance exists, or if `EventBus.publisher` does not reach ours
   through any property up to four levels deep.

**Rationale**: points 2 and 3 are the whole value: they make every
NestJS reliability module that takes a transaction explicitly join
`@Transactional` without the caller passing it. The rest keeps
`@nestjs/cqrs`'s own behaviour wherever we have no reason to change it.

**Verified by** `packages/cqrs/src/module/event-bus-composition.spec.ts`
on `@nestjs/cqrs` 12.1 and, in the CI `nest-11` job, 11.0.3. The spec
covers both contexts, the asynchronous outer publisher, the rollback on
its rejection, and both bootstrap checks.
