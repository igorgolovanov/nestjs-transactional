# ADR-009: Listener ID stability

## Status

Accepted — 2026-04-26.

> **Note (Phase 10, 2026-04-27):** The listener id format described
> here was originally derived from the method-level decorator
> shape (`${ClassName}.${methodName}`). [ADR-014](014-handler-api-redesign.md)
> superseded the listener API to class-level handlers and changed
> the format to `${baseId}#${EventName}`. The stability *contract*
> in this ADR is unchanged; only the format moved. Cross-link with
> [DD-013](../dd/013-class-level-handler-api.md) for the redesign
> rationale.

## Context

The outbox ([ADR-006](006-outbox-pattern.md)) writes a row to
`event_publication` for every event published inside a
transaction. The row carries — in addition to the payload and
event type — a **listener id**: the identifier of the
`@OutboxEventsHandler` (or `@IntegrationEventsHandler`) that the
worker should invoke when this row is picked up.

The listener id has to be **stable across deployments**. If a
deployment renames a handler class and the listener id derives
from the class name, every pending row from before the rename
becomes unresolvable — the worker can't find a handler that
matches the stored id, and the row stays stuck.

Three flavours of "unresolvable" matter:

1. **Renamed handler.** A row with id `'OldShippingHandler'` exists
   in the table; the new code only knows
   `'NewShippingHandler'`. The row goes to `FAILED` (no listener
   for id) — operators have to manually edit rows or accept the
   loss.
2. **Refactored handler method**. Pre-Phase 10, listener ids were
   `${ClassName}.${methodName}`. Renaming the method (a routine
   refactor that should not affect behaviour) silently
   invalidated stored rows.
3. **Multiple listeners for the same event.** When a class
   handles multiple events, the id needs to disambiguate which
   event invocation a stored row corresponds to.

The choice of id format is therefore a design decision with
operational implications, not just an internal naming convention.

## Decision

The listener id format is **`${baseId}#${EventName}`**:

- **`baseId`** defaults to the handler class name. Users override
  it via the decorator option to pin an id that survives class
  renames:

  ```ts
  @OutboxEventsHandler({
    events: [OrderPlacedEvent],
    id: 'shipping.create-shipment',  // pinned baseId
  })
  export class ShippingHandler implements IOutboxEventHandler<OrderPlacedEvent> {
    handle(event: OrderPlacedEvent): Promise<void> { ... }
  }
  ```

- **`EventName`** is the event class name from
  `event.constructor.name`. Listening to multiple events from
  one handler class produces one id per event:
  `'shipping.create-shipment#OrderPlacedEvent'`,
  `'shipping.create-shipment#OrderCancelledEvent'`.

The framework writes the listener id to `event_publication.listener_id`
at publish time and reads it back at dispatch time. The
worker matches stored rows to live handlers by exact id equality —
no fuzzy matching, no fallbacks.

### Stability contract

Once a handler is in production:

- **Renaming the handler class is safe** if the user has pinned
  an `id:` in the decorator. The class name no longer affects
  the stored rows.
- **Renaming the handler class is UNSAFE** if `id:` is absent
  (the default). Pending rows become unresolvable until either
  manually migrated or accepted as lost.
- **Adding a new event** to a handler class produces new ids
  (`baseId#NewEvent`); old ids continue to be matched. Safe.
- **Removing an event** from a handler class makes the
  corresponding ids unresolvable — same hazard as a class rename
  for those event types. Mitigation: leave the handler in place
  and make `handle` a no-op until pending rows drain, then
  remove.

### Documentation surface

- The decorator's JSDoc lists `id:` as recommended for any
  handler intended for production.
- The package README ("Listener id stability" section) walks
  through the rename scenario.
- CLAUDE.md "DO NOT rename handler classes carelessly" note
  cross-references this ADR.

## Alternatives Considered

### Class name only as the id

Listener id = `event.constructor.name` of the handler class.
Simple, no decorator option needed.

Rejected because:

- A handler that listens to multiple events would have one id
  for all of them, and the worker couldn't distinguish which
  event a stored row was for. The disambiguation is structurally
  necessary.
- Any class rename invalidates rows with no opt-out.
- The single string offers no place to record an explicit
  stable id.

### Method name only as the id

Pre-Phase-10 method-level decorators used
`${ClassName}.${methodName}` (close to this option but
combined with the class name).

Rejected after Phase 10's redesign because:

- Method-level decorators are themselves rejected
  ([ADR-014](014-handler-api-redesign.md)) — this option falls
  with them.
- Method names are even more change-prone than class names; a
  routine refactor (rename for clarity, extract method, ...)
  silently breaks publication processing.

### Hash of the handler's source

Compute a hash of the handler class body and use it as the id.
Refactoring breaks the hash; class renames don't.

Rejected because:

- Refactoring is the more common operation. We want refactors to
  be safe; we want renames to be opt-in via `id:`.
- Hashes are opaque to operators reading
  `event_publication.listener_id` in `psql`. Stable string ids
  read better.
- Cross-version drift across deployments produces different
  hashes for what is effectively the same handler — destabilises
  stored rows.

### Configuration-file-based id mapping

A `listener-ids.json` mapping in `OutboxModule.forRoot()` that
maps class names to stable ids.

Rejected because:

- Splits the listener identity across two locations (decorator
  AND config file) — refactors must update both.
- Adds a configuration surface that grows with each new handler.
- The `id:` decorator option achieves the same stability contract
  with the identity colocated with the handler.

### UUID per handler, generated at first registration

Generate a UUID at first publish, store it in a sidecar table,
match by UUID on subsequent publishes.

Rejected because:

- Adds an additional DB roundtrip and a sidecar table.
- Cross-environment portability suffers — staging UUIDs differ
  from production, complicating debug.
- The first publish of a handler at deploy time still has to
  pick an id from somewhere; the bootstrap problem stays.

## Consequences

### Positive

- **Refactor-safe by default.** Renaming an unrelated method
  inside the handler class doesn't change the listener id. The
  Phase 10 redesign + this ADR's format choice make this true.
- **Explicit opt-in for class-rename safety.** The `id:` option
  is the single discoverable place to pin stability. The
  decorator's JSDoc, the package README, and CLAUDE.md all
  point at it.
- **Multi-event handlers disambiguate naturally.** A handler
  class handling N events produces N ids
  (`baseId#Event1`, `baseId#Event2`, ...) — the worker matches
  unambiguously.
- **Operator-readable.** `SELECT listener_id FROM
  event_publication WHERE status = 'FAILED'` shows
  `'shipping.create-shipment#OrderPlacedEvent'` —
  human-parseable.

### Negative

- **Easy to forget the `id:` option.** Users who don't read the
  README or look at the JSDoc carefully can ship a production
  handler without a pinned id, and learn the hard way at the
  first rename.
- **Removing an event from a handler is disruptive.** Pending
  rows for that event become unresolvable. Mitigation is
  documented (no-op the handler until rows drain), but the
  graceful migration takes ops effort.
- **No automated lint for missing `id:`.** A future tooling
  iteration could warn at build time if a handler class lacks
  `id:`. Not scheduled.

### Mitigations

- The decorator's JSDoc carries an explicit "Recommended for
  production" note on `id:`.
- The package README includes a "Listener id stability"
  section with the rename / refactor / removal walkthroughs.
- CLAUDE.md "DO NOT rename handler classes carelessly once the
  outbox is in use" cross-references this ADR with the
  prescriptive rule.
- `FailedEventPublications` (the operator API) exposes
  publications with stuck listener ids; ops can see them via
  `failed.findAll()` and act before the volume becomes
  unwieldy.

## Notes

- The id format is set in
  `packages/outbox/src/registry/listener-registry.ts` (search
  for `composeListenerId`); the format is also documented in
  `event-publication.ts` next to the field declaration.
- This ADR ties together two seemingly-separate constraints —
  class-rename hazard and multi-event disambiguation — into one
  format. ADR-014's Phase 10 redesign was driven in part by
  the same family of stability concerns; both ADRs reinforce
  the rule.
- A future iteration may add a `LISTENER_ID_FORMAT_VERSION`
  symbol to the row schema so a future format change can
  coexist with stored rows during migration. Not yet needed —
  flagged here for visibility.
