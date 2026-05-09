# ADR-003: Not patching @nestjs/cqrs — integrate via runtime wrapping and DI override

## Status

Accepted — 2026-04-23.

## Context

Spring-style transactional event delivery (per
[ADR-002](002-transactional-events-spring-semantics.md)) requires
deep integration with the CQRS layer. Specifically, the framework
must:

1. **Wrap `CommandHandler.execute`** in a transaction so that
   `@Transactional` on the handler class works.
2. **Wrap `QueryHandler.execute`** in a read-only transaction by
   default (so that queries don't accidentally pin write locks).
3. **Retarget `AggregateRoot.commit()`** so that aggregate events
   route through the transactional dispatcher rather than firing
   immediately on the in-memory `EventBus`.
4. **Discover handler classes at bootstrap** — match the patterns
   `@nestjs/cqrs` uses for `@CommandHandler` /
   `@QueryHandler` / `@EventsHandler` so we can apply our
   wrapping consistently.

`@nestjs/cqrs` provides the bus infrastructure
(`CommandBus`, `QueryBus`, `EventBus`), the
`@CommandHandler` / `@QueryHandler` / `@EventsHandler`
decorators, and `AggregateRoot` with its `EventPublisher` DI
token. None of those expose hooks for transaction integration.
The library is not designed for it; the transaction-aware needs
came after `@nestjs/cqrs` had stabilised its API.

There are two architectural ways out:

- **(A) Fork** `@nestjs/cqrs` and ship a modified version that
  adds transaction-aware semantics natively.
- **(B) Layer on top** without modifying it: wrap handlers at
  runtime via `DiscoveryService`, override the `EventPublisher`
  DI token, register a parallel dispatcher.

## Decision

Adopt **(B) Layer on top**. Do not fork `@nestjs/cqrs`. The
integration uses exactly three mechanisms:

### 1. Runtime handler wrapping

A `CqrsHandlerWrapper` runs at `OnApplicationBootstrap`. Via
`DiscoveryService` it locates every provider with
`@CommandHandler` / `@QueryHandler` / `@EventsHandler`
metadata, reads any `@Transactional` metadata from the class
or its `execute` method, and replaces `instance.execute` with
a wrapper that calls `transactionManager.run(...)` around the
original.

`@nestjs/cqrs`'s buses then call the (now-wrapped)
`execute` method without knowing it's been instrumented; the
wrapping is invisible to the library.

This is the third mechanism in the wrapping triad documented in
[ADR-005](005-method-wrapping-strategy.md).

### 2. EventPublisher DI override

`@nestjs/cqrs` exports the `EventPublisher` class and uses it as
both a class and a DI token in `AggregateRoot.commit()`'s
internals. We register a `TransactionalEventPublisherAdapter`
under the same DI token with `useClass`. When user code does the
canonical `mergeObjectContext(order)` ... `order.commit()`
sequence, the override transparently routes events through the
transactional dispatcher.

The override surface is one DI provider entry. It's narrow,
explicit, and documented.

### 3. Parallel dispatcher

The `TransactionalEventDispatcher` is our own service. It is
not a fork of `EventBus`; it coexists. Events from
`AggregateRoot.commit()` (via the publisher override) route to
our dispatcher; phase hooks are then registered on the active
transaction. The original `EventBus` continues to exist and
serve the use cases (mostly transaction-naive, in-memory
listeners) it was designed for.

`@nestjs-transactional/cqrs` exports
`@TransactionalEventsHandler` as the user-facing decorator;
handlers using it are picked up by our scanner, not by
`@nestjs/cqrs`'s `EventsHandler` infrastructure.

## Alternatives Considered

### Fork `@nestjs/cqrs`

Maintain a `@nestjs-transactional/cqrs-core` package that ships
modified bus/handler internals.

Rejected for these reasons:

- **Maintenance burden.** Every `@nestjs/cqrs` upstream release
  needs us to rebase, retest, and republish. Bug fixes and
  ecosystem improvements arrive late or not at all.
- **Ecosystem fragmentation.** Other libraries (sagas, custom
  buses, third-party `EventsHandler`s) target the original
  `@nestjs/cqrs`. A fork forces every consumer of
  `@nestjs-transactional/cqrs` to also rip out and replace
  any other CQRS-touching libraries they use.
- **Migration friction for new adopters.** A team already on
  `@nestjs/cqrs` can drop our package in via
  `CqrsTransactionalModule.forRoot()` without changing a line
  of handler code. With a fork, they'd swap their imports and
  retest the entire CQRS layer.
- **Loss of upstream upgrade path.** When `@nestjs/cqrs` ships
  a v12, our users want to follow at their own pace, not be
  blocked on us catching up.

### Build our own CQRS-like package

Roll a NestJS-native command/query/event infrastructure from
scratch, deprecate the integration with `@nestjs/cqrs`.

Rejected for these reasons:

- **Massive scope expansion.** We'd be in the bus business,
  the saga business, the event-streaming business, the
  registration-pattern business. None of those is the
  framework's mission (declarative transactions, durable
  events).
- **Ecosystem fragmentation, again.** Forces a hard choice
  between our framework and `@nestjs/cqrs` for any team that
  values the larger ecosystem already built around the
  upstream package.
- **Not what users want.** The signal from prospective adopters
  is "I love `@nestjs/cqrs`, I just want it to play nicely
  with transactions" — not "give me a new CQRS library".

### Method-level patching at decoration time

Have `@CommandHandler` (the `@nestjs/cqrs` decorator) trigger
our wrapping immediately at class-definition time, by
augmenting the descriptor.

Rejected because the decorator runs at module load with no
access to the DI container, and `TransactionManager` is a DI
provider (it must be — it varies per-`forRoot`). The wrapping
needs DI; it has to defer to bootstrap. Same root reasoning
as in [ADR-005](005-method-wrapping-strategy.md), point (2).

## Consequences

### Positive

- **Drop-in for `@nestjs/cqrs` users.** Existing CQRS code
  works as-is; the framework adds transaction semantics
  transparently. The migration path is `pnpm add` plus
  `CqrsTransactionalModule.forRoot()` in `AppModule`.
- **Upstream upgrade path stays normal.** Users follow
  `@nestjs/cqrs`'s release cadence; we follow with a peer
  dependency bump when `@nestjs/cqrs` ships a major. No
  blocking.
- **Clean conceptual layering.** `@nestjs/cqrs` does CQRS;
  we do transactions. The two libraries don't compete for the
  same conceptual space.
- **Smaller surface to maintain.** We own the wrapper, the
  publisher adapter, and the dispatcher. `@nestjs/cqrs` owns
  the rest. Our maintenance load is bounded.

### Negative

- **We depend on `@nestjs/cqrs` internals.** Specifically the
  `EventPublisher` DI token shape, the `@CommandHandler` /
  `@QueryHandler` / `@EventsHandler` metadata patterns, and
  `AggregateRoot`'s `publishAll` flow. If a future
  `@nestjs/cqrs` major changes any of these, our integration
  breaks until we adapt.
- **Two parallel event-delivery channels** (the original
  `EventBus` and our `TransactionalEventDispatcher`). Users
  must understand which is which. Mitigated by the
  `@IntegrationEventsHandler` smart default
  ([ADR-014](014-handler-api-redesign.md)) — most users don't
  reach for either explicitly.
- **`@TransactionalEventsHandler` looks similar to
  `@EventsHandler` but isn't the same thing.** Users who
  reach for the wrong decorator end up with non-transactional
  delivery and may not notice until production. Mitigated by
  the `@IntegrationEventsHandler` smart default and by the
  decision in
  [ADR-014](014-handler-api-redesign.md) to align our
  decorator's class-level shape with `@nestjs/cqrs`'s — the
  symmetry makes the divergence visible.

### Mitigations

- **Don't import `CqrsModule` directly alongside
  `CqrsTransactionalModule.forRoot()`** — Convention #6 in
  CLAUDE.md. The transactional module imports `CqrsModule`
  internally and overrides the `EventPublisher` DI token; a
  duplicate `CqrsModule` import in the consumer shadows the
  override and aggregate events bypass the dispatcher.
  Documented in `packages/cqrs/README.md`.
- The `@nestjs/cqrs` peer-dependency range is pinned narrowly
  (currently `^11.0.0`); a peer-dependency violation is a
  loud failure at install time, not a silent runtime
  surprise.
- The class-level handler API in
  [ADR-014](014-handler-api-redesign.md) deliberately mirrors
  `@nestjs/cqrs`'s `@EventsHandler` ergonomics so the
  conceptual mapping reads naturally.
- Integration tests in `packages/cqrs/test/integration/` lock
  the upstream contract: any `@nestjs/cqrs` version bump that
  breaks the integration trips a test in CI before reaching
  users.

## Notes

- This decision is a peer of [ADR-005](005-method-wrapping-strategy.md):
  ADR-005 documents the *triad* of wrapping mechanisms across
  the framework; ADR-003 documents the *integration strategy*
  with `@nestjs/cqrs` specifically. The CqrsHandlerWrapper from
  ADR-005 is one of the three mechanisms; this ADR explains
  why we built that mechanism rather than a fork.
- This decision is upstream of every later CQRS-related ADR.
  ADR-014 (class-level handlers) lives *inside* the layered
  integration; it would not be possible if we had forked.
