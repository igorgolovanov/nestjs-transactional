# DD-019: Atomicity unit and execution order for hybrid delivery

**Context**: A single event may have local handlers
(`@TransactionalEventsHandler` / `@OutboxEventsHandler` /
`@IntegrationEventsHandler`) AND an `@Externalized` mapping. We must
define what happens when local delivery succeeds but external publish
fails (or vice versa) — without a clear atomicity contract,
partial-success states leak into user code as surprising bugs.

**Alternatives considered**:
- Track partial success per channel (separate publication entries for
  local and external delivery). Rejected: significantly increases
  publication-row volume and processing complexity for marginal benefit.
- External-first, local handlers second. Rejected: errors in local
  handlers are usually faster and cheaper to detect than broker-side
  failures; failing fast on local errors avoids needless broker traffic.
- Multi-row publication (one row per delivery target). Rejected:
  overcomplicated model, harder operator APIs, marginal benefit over
  single-unit semantics.

**Decision**:
- **Single unit atomicity**: one publication row covers ALL deliveries
  for the event. The row's status (`COMPLETED`, `FAILED`) reflects the
  whole unit — either every channel succeeded, or the row is retried.
- **Execution order**: local handlers run first, externalization runs
  after.
- **Idempotency requirement**: handlers and broker consumers must be
  idempotent — the at-least-once guarantee inherent to retry means a
  handler may run more than once if a later step in the same publication
  fails.

**Consequences**:
- Simple mental model for users: one event = one publication row.
- Clear documentation requirement around idempotency for both local
  handlers and downstream consumers of externalized events.
- Possible double execution of a local handler if externalization fails
  after a successful local handler run — acceptable trade-off given
  idempotency is already required for at-least-once semantics.
- Operator APIs (`FailedEventPublications`, `IncompleteEventPublications`)
  work uniformly across local-only, external-only, and hybrid setups.
