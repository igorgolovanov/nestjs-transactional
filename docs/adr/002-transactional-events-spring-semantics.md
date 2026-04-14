# ADR-002: Transactional events with Spring semantics

## Status

Accepted — 2026-04-23.

> **Note (Phase 10, 2026-04-26):** The decorator and interface
> shapes referenced here were originally method-level
> (`@TransactionalEventsListener` on a method). Phase 10
> ([ADR-014](014-handler-api-redesign.md)) replaced the API with
> class-level handlers (`@TransactionalEventsHandler` on a class
> implementing `ITransactionalEventHandler<T>`). The foundational
> decision in this ADR — Spring's four-phase delivery semantics —
> is unchanged and inherited by the new shape verbatim.

## Context

Once an application moves beyond plain CRUD, it inevitably grows
event-driven code paths: "after we save the order, schedule
shipping", "after we charge the card, send the receipt", "after
we update the inventory, invalidate the pricing cache." With
`@nestjs/cqrs` this is straightforward — the
`AggregateRoot.commit()` flushes events to the in-memory
`EventBus`, listeners run, life is good.

The first production incident is always the same. The repository
`save` succeeds, the `EventBus` fires, listeners do their thing
(send email, charge card, ship goods) — and then something in
the wrapping transaction throws. The transaction rolls back. The
order row never landed in the database. But the email went out,
the card was charged, the shipment was scheduled. Customers see
"something happened" without the order ever having existed.

The classical fix is to defer event delivery until *after* the
transaction commits. Spring Framework's
`@TransactionalEventListener` does exactly that, with four
distinct phases:

- **`BEFORE_COMMIT`** — fires after all the application work but
  before the actual `COMMIT`. An exception here rolls the
  transaction back.
- **`AFTER_COMMIT`** — fires after a successful commit. The
  default. Fixes the email-sent-after-rollback class of bug.
- **`AFTER_ROLLBACK`** — fires after a rollback. Useful for
  cleanup (compensating actions, alerting).
- **`AFTER_COMPLETION`** — fires after either commit or rollback.
  For listeners that don't care about outcome (metrics, logging).

The Spring semantics are well-understood by the Java/JEE community
and well-documented. NestJS has nothing equivalent built-in —
`@nestjs/cqrs`'s `EventBus` is synchronous and transaction-naive;
plain `EventEmitter` is the same.

## Decision

Implement the four Spring phases as a first-class capability in
`@nestjs-transactional/cqrs`:

- A class-level decorator that marks a handler as participating
  in transactional event delivery (originally
  `@TransactionalEventsListener` on a method per Phase 1; now
  `@TransactionalEventsHandler` on a class per Phase 10 /
  ADR-014). The decorator carries the events list and an optional
  `phase: TransactionPhase` (default `AFTER_COMMIT`).
- A `TransactionPhase` enum with the four Spring values:
  `BEFORE_COMMIT`, `AFTER_COMMIT`, `AFTER_ROLLBACK`,
  `AFTER_COMPLETION`. The string values match Spring's casing so
  cross-ecosystem documentation stays consistent.
- A `TransactionalEventDispatcher` that, when an event is
  published inside a transaction, registers the matching
  handlers as **hooks on the active transaction** (via
  `manager.registerBeforeCommit` /
  `manager.registerAfterCommit` /
  `manager.registerAfterRollback`) instead of invoking them
  synchronously. The hooks fire at the appropriate phase as the
  transaction unwinds.
- An `EventPublisher` override
  (`TransactionalEventPublisherAdapter`) registered into
  `@nestjs/cqrs`'s DI in place of the default `EventPublisher`,
  so `AggregateRoot.commit()` automatically routes through the
  dispatcher. Users coming from `@nestjs/cqrs`'s
  `mergeObjectContext` pattern keep their idioms intact.

When an event is published *outside* a transaction, the
dispatcher invokes handlers with `fallbackExecution: true`
directly, and ignores the rest with a debug log. This protects
against the "I forgot to add `@Transactional`" footgun.

The four phases compose with the propagation modes from ADR-001:
nested transactions register hooks on their own scope, but the
hooks fire only when the **outermost** transaction completes
(commit/rollback). REQUIRES_NEW handlers fire on the inner
transaction's commit independently.

## Alternatives Considered

### Use `@nestjs/cqrs`'s built-in `EventBus` synchronously

The default behaviour. Events fire as soon as `commit()` is
called, before the wrapping transaction has committed.

Rejected because of the email-after-rollback class of bug above.
This is *the* canonical reason to want transactional events;
shipping the framework without it would defer the same incident
to every adopter.

### Implement `AFTER_COMMIT` only

Spring users do reach for `AFTER_COMMIT` an order of magnitude
more often than the other three phases combined. We could ship
just that one.

Rejected because:

- `BEFORE_COMMIT` is the canonical place to do
  validation-with-rollback ("if the audit table write fails,
  abort the whole transaction"). Without it, users can't model
  that pattern.
- `AFTER_ROLLBACK` is the canonical compensation hook
  (alerting, cleanup, retries). Removing it forces users to
  re-derive the transaction-context plumbing themselves.
- `AFTER_COMPLETION` is the canonical metrics/logging hook,
  fires regardless of outcome. Removing it forces users to
  register two listeners (one for commit, one for rollback).

The four phases are minimal; halving them halves usefulness.

### Pluggable phases (user-defined hook points)

Some frameworks let users register arbitrary hook points (e.g.
"before-flush", "after-flush", "in-savepoint"). More flexibility,
more complexity.

Rejected because the four Spring phases cover every documented
use case in the Spring Modulith reference, the Hibernate
reference, and the Java EE / Jakarta CDI references. We don't
have evidence that arbitrary hook points solve a real user
problem.

### Replace `@nestjs/cqrs` outright

Build a NestJS-native CQRS layer with first-class transaction
awareness, deprecate `@nestjs/cqrs` integration.

Rejected — see [ADR-003](003-not-patching-nestjs-cqrs.md). We
explicitly chose to integrate with `@nestjs/cqrs` rather than
fork or replace it.

## Consequences

### Positive

- **Spring-flavoured ergonomics.** Engineers who learned
  transactional events on Spring transfer their mental model
  with no friction.
- **Defaults to safe.** `AFTER_COMMIT` is the default phase, so
  the most-common case (don't fire if the transaction rolls
  back) is what users get without thinking.
- **Phase-aware composition with propagation.** Nested
  `REQUIRED` transactions register hooks on the outer scope;
  `REQUIRES_NEW` hooks fire on the inner scope independently.
  The composition mirrors Spring's behaviour exactly, so the
  Spring documentation reads as a manual for our package.
- **AggregateRoot integration "just works".** Users who already
  do `mergeObjectContext(order); order.commit()` get
  transactional delivery automatically once they import
  `CqrsTransactionalModule.forRoot()`.
- **Foundation for the outbox.** Phase 5 ([ADR-006](006-outbox-pattern.md))
  builds on the same phase machinery — `@OutboxEventsHandler`
  registers the publication row at `BEFORE_COMMIT` so the row
  commits with the business data; `@IntegrationEventsHandler`
  is `AFTER_COMMIT` + `REQUIRES_NEW` + durable. The four phases
  remain the lingua franca.

### Negative

- **Two delivery channels for events** (the in-memory dispatcher
  and the EventBus). Users must understand which they're using.
  Mitigated in [ADR-014](014-handler-api-redesign.md) by the
  `@IntegrationEventsHandler` smart default — most users don't
  pick the channel manually.
- **Listener id stability matters.** A method rename in a
  method-level decorator world (Phase 1 to Phase 10) changed
  the implicit listener id; this surfaced as
  [DD-013](../dd/013-class-level-handler-api.md) and motivated the
  move to class-level handlers in ADR-014.
- **Ordering between phases is partial.** Within `AFTER_COMMIT`
  hooks, ordering follows registration order — which means it
  follows DI scan order — which means it's stable but not
  semantically meaningful. We don't expose explicit ordering;
  users with strict ordering requirements use a single handler
  that orchestrates the steps in code.

### Mitigations

- `fallbackExecution: true` on a handler invokes it directly
  when no transaction is active; this catches the "I forgot
  `@Transactional`" footgun for handlers that genuinely should
  run unconditionally (metrics, logging).
- The dispatcher logs at `debug` level whenever it ignores an
  event because the publisher is outside a transaction, so
  operators can trace the silent-skip case.
- The post-Phase-5 outbox layer offers durable equivalents
  (`@OutboxEventsHandler` for AFTER_COMMIT, `@IntegrationEventsHandler`
  for AFTER_COMMIT + new-transaction + durable). Users who
  need at-least-once delivery cross the in-memory/durable
  boundary explicitly.

## Notes

- This ADR predates ADR-014 (class-level handler API) but the
  four-phase decision is unchanged. ADR-014 redesigned the
  decorator surface; the phase machinery underneath is the
  Phase 1 design verbatim.
- The dispatcher's hook routing logic is the foundation of the
  Phase 14.3.1 Category B per-DS dispatcher routing — see
  [ADR-018](018-multi-adapter-architecture.md) addendum for
  how `@TransactionalEventsHandler({ dataSource })` decides
  which active transaction's hook list to push onto.
