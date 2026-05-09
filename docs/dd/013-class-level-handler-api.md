# DD-013: Class-level handler API aligned with `@nestjs/cqrs`

**Context**: The original listener decorators were method-level —
annotate any method with `@TransactionalEventsListener(EventType)` and
it becomes a handler. That diverged from `@nestjs/cqrs`'s class-level
`@EventsHandler` / `@CommandHandler` / `@QueryHandler` convention, tied
listener ids to method names (breaking on rename), and left the handler
method signature unconstrained at the type level.

**Alternatives considered**:
- Extend method-level decorators with `Type[]` support for multi-event
  handlers. Rejected: still asymmetric with `@nestjs/cqrs`.
- Dual API (class-level + method-level). Rejected: two ways to do the
  same thing doubles maintenance and confuses users.
- Keep method-level with deprecation warnings. Rejected: pre-release,
  no users, no cost to a clean break.

**Decision**: Class-level only —
`@TransactionalEventsHandler(Event1, Event2, ...)`,
`@OutboxEventsHandler(Event1, Event2, ...)`,
`@IntegrationEventsHandler(Event1, Event2, ...)`. Each decorator also
accepts a long-form options object. Handler classes implement
`ITransactionalEventHandler<T>` / `IOutboxEventHandler<T>` /
`IIntegrationEventHandler<T>` and expose a single `handle(event)`
method. Listener ids are composed as `${baseId}#${EventName}` (baseId
defaults to the class name, can be overridden via `options.id`) — a
method rename inside a handler class no longer invalidates stored
publications.

**Consequences**: Mental-model symmetry with `@nestjs/cqrs`. Enforced
single-responsibility per handler class (a class handles one
cross-module integration concern). Breaking change vs. any pre-release
snapshot; migration is mechanical but required before upgrading past
this point. See [ADR-014](../adr/014-handler-api-redesign.md) for the
full design rationale.
