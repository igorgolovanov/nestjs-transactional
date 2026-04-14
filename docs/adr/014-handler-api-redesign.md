# ADR-014: Class-level handler API, matching `@nestjs/cqrs` conventions

- **Status**: Accepted
- **Date**: 2026-04-24
- **Supersedes**: ADR-010 (hybrid event publishing — not yet written, the
  design embedded in this ADR replaces what would have gone into it)
- **Related**: ADR-003 (not patching @nestjs/cqrs),
  ADR-006 (outbox pattern rationale),
  ADR-007 (outbox architecture: core + typeorm split)

> **Note (Phase 10 naming refinement, 2026-04-25):** The class-level
> decorator named `@ApplicationModuleHandler` in this ADR was later
> renamed to **`@IntegrationEventsHandler`** (interface
> `IIntegrationEventHandler`, scanner
> `IntegrationEventsHandlerScanner`) to align with DDD/microservices
> terminology and avoid collision with NestJS `@Module()` semantics.
> The original ADR text below intentionally preserves the names that
> were correct at the time it was accepted; treat occurrences of
> `@ApplicationModuleHandler` / `IApplicationModuleHandler` /
> `ApplicationModuleHandlerScanner` in the body as historical record,
> map them to their current names when consulting the codebase. See
> [DD-013](../dd/013-class-level-handler-api.md) and the
> CLAUDE.md "Phase 10: Class-level handler API + naming refinement"
> entry for the second-pass rationale.

> **Note (Phase 12 package rename, 2026-04-26):** Throughout this ADR's
> original text, the abstract outbox package was named
> `@nestjs-transactional/outbox-core`. It was renamed to
> `@nestjs-transactional/outbox` in Phase 12. Body references have been
> updated inline; the handler-API decision content is unchanged.

## Context

Until this ADR, the listener decorators in both `@nestjs-transactional/cqrs`
and `@nestjs-transactional/outbox` were **method-level**:

```ts
@Injectable()
export class InventoryHandlers {
  @TransactionalEventsListener(OrderPlacedEvent)
  async onOrderPlaced(event: OrderPlacedEvent): Promise<void> { ... }

  @OutboxEventListener(OrderShippedEvent)
  async onShipped(event: OrderShippedEvent): Promise<void> { ... }
}
```

This diverged from the convention established by `@nestjs/cqrs` itself,
where message handlers are **class-level** — `@CommandHandler`,
`@QueryHandler`, `@EventsHandler`:

```ts
@EventsHandler(OrderPlacedEvent, OrderShippedEvent)
export class InventoryHandler implements IEventHandler<OrderPlacedEvent | OrderShippedEvent> {
  async handle(event: OrderPlacedEvent | OrderShippedEvent): Promise<void> { ... }
}
```

The method-level design had accumulated three specific problems:

1. **Ergonomic asymmetry with NestJS**: every other handler decorator in
   the `@nestjs/cqrs` ecosystem is class-level and uses a `handle(event)`
   method. Ours required a different mental model — prefix method names
   with `on*`, write distinct method signatures, remember that the
   method name participates in the listener id.

2. **Listener id tied to method name**: the default id was
   `${className}.${methodName}`. Renaming a decorated method — e.g.
   `onOrderPlaced` → `handleOrderPlaced` — silently orphaned every
   stored publication referring to the old id. Consumers who forgot to
   supply an explicit `options.id` paid in hours of debugging after a
   refactor.

3. **Unconstrained shape**: nothing in the type system required a
   decorated method to be async, or to take exactly one argument, or
   to return `Promise<void>`. Mistakes surfaced only at runtime, often
   under load.

We are pre-release: no external users, no stored publications in
production databases. The moment to correct the design is now, not
after 0.1.0.

## Decision

Replace all three method-level decorators with class-level equivalents,
mirroring the ergonomics of `@nestjs/cqrs` `@EventsHandler`:

| Old (method-level)                 | New (class-level)                  |
|------------------------------------|------------------------------------|
| `@TransactionalEventsListener`     | `@TransactionalEventsHandler`      |
| `@OutboxEventListener`             | `@OutboxEventsHandler`             |
| `@ApplicationModuleListener`       | `@ApplicationModuleHandler`        |

Each decorator:

- Is **class-level only**. No method-level API exists.
- Accepts event types either as **rest parameters** (short form) or
  via an **options object** with `{ events, ... }` (long form).
- Requires the class to expose a `handle(event): Promise<void> | void`
  method. Type-safety is enforced by implementing the corresponding
  `I*Handler` interface:
  - `ITransactionalEventHandler<T>`
  - `IOutboxEventHandler<T>` — `handle` returns `Promise<void>` only
    (async-only)
  - `IApplicationModuleHandler<T>`

Example:

```ts
// Short form
@TransactionalEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
export class OrderProjection
  implements ITransactionalEventHandler<OrderPlacedEvent | OrderCancelledEvent>
{
  handle(event: OrderPlacedEvent | OrderCancelledEvent): void { ... }
}

// Long form with explicit options
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  phase: TransactionPhase.BEFORE_COMMIT,
  async: false,
})
export class OrderValidation implements ITransactionalEventHandler<OrderPlacedEvent> {
  handle(event: OrderPlacedEvent): void { ... }
}
```

### Listener id composition

Multi-event handlers need distinct listener ids per event type. The
scanner composes ids as `${baseId}#${EventName}`:

- **No explicit `id`**: baseId = class name. Example:
  `OrderProjection#OrderPlacedEvent`, `OrderProjection#OrderCancelledEvent`.
- **Explicit `id`**: baseId = the supplied id. Example:
  `order.projection#OrderPlacedEvent`.

Renaming a class without an explicit `id` still breaks stored
publications — the same failure mode as before, with one refinement:
the id is now tied to the class name, not the method name, so a method
rename inside a class is safe.

### `@ApplicationModuleHandler` — smart scanner

Under the old `@ApplicationModuleListener`, the decorator wrote two
metadata keys (transactional-listener + outbox-listener) and relied on
`TransactionalListenerScanner` to read BOTH and skip the in-memory
registration when the outbox was wired. This was fragile — the
skip-logic crossed package boundaries via a `Symbol.for(...)`
well-known key.

The replacement is cleaner. `@ApplicationModuleHandler` writes ONE
dedicated metadata key. A new `ApplicationModuleHandlerScanner` in the
cqrs package decides at bootstrap which path to wire, based on whether
an `OutboxListenerRegistrar` is bound under the
`OUTBOX_LISTENER_REGISTRAR` DI token:

- Registrar bound → register with the outbox registry, `REQUIRES_NEW`
  transaction wrapper, durable / retried / resumable.
- Registrar not bound → register with `TransactionalEventDispatcher`
  as `AFTER_COMMIT` + `async: true`, wrapped in a fresh transaction.

The registrar is a **structural port** declared in the cqrs package —
`outbox`'s `OutboxListenerRegistry` satisfies the interface
without cqrs importing from outbox (same pattern as
`OUTBOX_PUBLICATION_SCHEDULER`). Consumers bind the token explicitly in
their app module:

```ts
providers: [
  { provide: OUTBOX_LISTENER_REGISTRAR, useExisting: OutboxListenerRegistry },
],
```

### No method-level API

The option of offering both class-level AND method-level (or a "fluent"
`@On(Event)` within a class) was considered and rejected:

- Two ways to do the same thing doubles documentation, support surface,
  and cognitive load.
- Method-level lets a single class handle multiple events with distinct
  reactions — which is the opposite of single responsibility. Each
  handler class is one cross-module integration point; multiple event
  types mapping to one `handle` method is natural; multiple reactions
  want multiple classes.
- Matching `@nestjs/cqrs` exactly is more valuable than flexibility
  nobody explicitly asked for.

## Alternatives considered

1. **Add `Type | Type[]` support to the existing method-level
   decorators** — would have fixed multi-event ergonomics but left the
   asymmetry with `@nestjs/cqrs` in place. Rejected: half-measure.
2. **Dual API (class-level + method-level via `@On(Event)` inside
   decorated classes)** — more flexibility, more maintenance. Rejected:
   cardinality is a consequence of class design, not API concession.
3. **Keep the old API with deprecation warnings** — would have
   preserved existing code at the cost of duplicate decorators for
   every intended scope. Rejected: pre-release, no users, no cost to a
   clean break.

## Consequences

**Positive**

- Symmetry with `@nestjs/cqrs` conventions — one mental model across
  CQRS handlers, queries, commands, and event listeners.
- Type-safe `handle(event)` contract enforced by the `I*Handler`
  interfaces.
- Listener id no longer tied to method name — safe to rename methods
  within a handler class.
- Smart scanner for `@ApplicationModuleHandler` is self-contained:
  one metadata key, one scanner, one decision point. The old
  double-metadata + skip-logic pattern is gone.
- Single-responsibility enforced at the class level — a handler class
  does one thing, which makes tests tighter and errors easier to
  attribute.

**Negative**

- Breaking change vs. pre-release snapshots. Migration is mechanical
  (rename decorator, move method into `handle`, implement the
  interface) but required before upgrading past this point.
- Each independent reaction to an event needs its own class. In the
  rare case where one genuinely wanted two methods with different
  phases/settings on the same event, two classes are now the only
  option. This is a deliberate design pressure, not an accident.
- Listener id format change (`${className}.${methodName}` →
  `${className}#${EventName}`) invalidates publications stored under
  the old format — these become orphans after migration. The migration
  guide describes the cleanup path.

## Migration

See `docs/guides/migrating-to-outbox.md`. Summary:

1. Move the decorated method into `handle(event)`.
2. Lift the decorator up to the class.
3. Implement the matching `I*Handler` interface for type safety.
4. If multiple methods existed on one class with different phase
   configurations, split them into separate classes.
5. Before re-running the application against a database with stored
   publications from the old API, either (a) clear the
   `event_publication` table in a controlled maintenance window, or
   (b) re-register the old listener ids explicitly using the
   programmatic `OutboxListenerRegistry.register(...)` API to drain
   leftovers.
