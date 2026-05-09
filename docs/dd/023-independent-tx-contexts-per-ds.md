# DD-023: Independent transaction contexts per dataSource

**Context**: Code asking "is there an active transaction *for
billing*?" must not be confused by "is there an active transaction
*for inventory*?". Crossing a dataSource boundary must not silently
enrol the second adapter into the first adapter's transaction —
that would imply distributed-transaction semantics we do not provide.

**Alternatives considered**:
- Per-dataSource `AsyncLocalStorage` instance. Rejected during
  Phase 14.2 planning: delivers the same semantic guarantee
  (disjoint state per dataSource) but cascades a static→instance
  migration of `TransactionContext` through every consumer
  (adapter helpers, CQRS dispatcher, outbox publisher,
  approximately 487 tests). No behavioural improvement over keying
  on a shared ALS.
- XA / 2PC across dataSources. Rejected — see
  [ADR-018](../adr/018-multi-adapter-architecture.md) "Alternatives
  considered" for the full reasoning. Briefly: poor Node.js driver
  support, divergent semantics across stores, operational cost of
  XA-aware infrastructure unjustified for the patterns this ADR
  targets.

**Decision**: A single shared `AsyncLocalStorage` carries a
per-scope store whose active-transaction `Map` is keyed by
dataSource name. Separation is enforced through the key namespace —
cross-dataSource enrolment is structurally impossible because the
keys are disjoint. This extends the existing
[DD-005](005-multi-datasource-first-class.md) architecture
(composite `${adapterName}:${instanceName}` keys) by standardising
on the dataSource name as the single identifier going forward.
Distributed transactions are explicitly NOT supported.

**Consequences**: Cross-dataSource consistency is an
*application-level* concern. The recommended pattern is "write to
dataSource A, publish a durable event, consume the event on
dataSource B" — i.e. the outbox stack is the consistency boundary
between dataSources. Documented prominently in the migration
guide. The single-unit atomicity contract from
[DD-019](019-hybrid-delivery-atomicity.md) applies to each
dataSource independently. `TransactionContext`'s static API
remains intact — Phase 14.2 does not refactor it.
