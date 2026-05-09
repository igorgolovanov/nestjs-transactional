# DD-024: Smart `OutboxEventPublisher` facade

**Context**: With multiple outbox stacks (one per dataSource),
naively-injected `OutboxEventPublisher` becomes ambiguous — which
one? Forcing every call site to inject and select would cripple
single-adapter ergonomics.

**Alternatives considered**:
- Multiple injection tokens, no facade. Rejected: every business
  service that publishes events grows a per-dataSource constructor
  parameter. Punishes single-adapter users with no benefit.
- Auto-detection only, no override. Rejected: breaks down at the
  edges (no active transaction, two dataSources active at once via
  nested `@Transactional`, bootstrap code, tests).

**Decision**: A facade `OutboxEventPublisher` (the default-injected
publisher) inspects the active per-dataSource transaction context
and routes the event to the corresponding underlying publisher.
Explicit override is supported via a second argument:

```ts
this.publisher.publish(event);                            // implicit
this.publisher.publish(event, { dataSource: 'billing' }); // explicit
```

When no transaction is active and no explicit override is given,
the facade falls back to `'default'`.

**Consequences**: Single import works for both single-adapter and
multi-adapter consumers. The facade is a small piece of composition
on top of the per-dataSource publishers; it does not introduce new
state. See [ADR-018](../adr/018-multi-adapter-architecture.md)
point 8.
