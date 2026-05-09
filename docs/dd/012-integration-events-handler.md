# DD-012: @IntegrationEventsHandler as smart default

**Context**: Spring Modulith's `@ApplicationModuleListener` is the
recommended default for cross-module integration. It combines
AFTER_COMMIT, async execution, a new transaction, and persistence. Users
should not need to manually compose 3–4 decorators for the common case.

**Alternatives considered**:
- Only provide `@OutboxEventsHandler`, let users compose with
  `@Transactional` when needed. Rejected: does not match Spring Modulith
  DX.
- Make it a composite decorator that works without the outbox. Done
  partially (see Decision below).

**Decision**: `@IntegrationEventsHandler` is a standalone class-level
decorator in the cqrs package. A dedicated
`IntegrationEventsHandlerScanner` decides the delivery path at
bootstrap by inspecting the `OUTBOX_LISTENER_REGISTRAR` DI token: when
bound, registers with the outbox registry (durable,
at-least-once, retried). When unbound, registers with
`TransactionalEventDispatcher` as `AFTER_COMMIT` + `async: true`,
wrapped in a fresh transaction. Behavior in both modes is documented
explicitly.

**Consequences**: Matches Spring Modulith DX. Behavior differs based on
config — must be clearly documented to avoid surprises.
