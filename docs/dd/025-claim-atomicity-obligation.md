# DD-025: The claim carries the concurrency guarantee, not the poll

**Context**: [ADR-007](../adr/007-outbox-architecture.md) declared, in
its `SPI contract` appendix, that production
`findReadyForProcessing` implementations "must use
`FOR UPDATE SKIP LOCKED` or equivalent", and the
`EventPublicationRepository` JSDoc repeated it as the way to "be safe
against concurrent workers". Neither shipped implementation does this:
`TypeOrmEventPublicationRepository` polls without row locks (the
locking design was dropped before release), and
`InMemoryEventPublicationRepository` — which ADR-007 calls the
executable reference for the SPI — is a plain filter. The interface's
own JSDoc also contradicted itself: `tryClaim` correctly claimed to
"prevent double-processing across workers" while
`findReadyForProcessing` claimed the same responsibility.

So the SPI had a normative requirement that nothing implemented, on
the wrong method, stated in two places that disagreed. Left alone, the
first `outbox-prisma` / `outbox-mongodb` author would implement to a
contract the reference backends do not honour — or, worse, read
"`tryClaim` is advisory" out of the ambiguity and ship a read-then-write
claim, which is silently wrong under concurrency.

The reason the locking design was dropped is worth recording, because it
is what makes the requirement misplaced rather than merely unimplemented:
a pessimistic row lock only holds for the life of the transaction that
took it, so `SELECT ... FOR UPDATE SKIP LOCKED` would need a transaction
wide enough to span the listener invocation. Listeners are user code of
unbounded duration. Holding a database transaction open across them is
not acceptable.

**Alternatives considered**:

- **Implement the stated contract** — restore
  `SELECT ... FOR UPDATE SKIP LOCKED` in `outbox-typeorm`. Rejected for
  the reason above: it requires a listener-spanning transaction.
- **Require exclusivity from the poll by other means** — e.g. a
  claim-token column stamped by the poll itself. Rejected: that is
  `tryClaim` with extra steps, and it would push a second atomicity
  obligation onto every backend.
- **Delete the sentence and say nothing** — leaves backend authors with
  no stated concurrency obligation at all, which is how a read-then-write
  `tryClaim` gets shipped.
- **Supersede ADR-007** with a new ADR restating the SPI contract.
  Rejected as disproportionate: ADR-007's Decision is the
  `outbox` / `outbox-typeorm` package split, which is unchanged and
  correct. Only its descriptive appendix drifted, and the file already
  carries a precedent for inline factual amendment (the Phase 12
  package-rename note).

**Decision**:

- **`tryClaim` is where the concurrency guarantee lives.** Its status
  check and status transition MUST be one indivisible operation:
  a conditional `UPDATE ... WHERE status IN (...)` reporting an
  affected-row count, a `findOneAndUpdate` with the status in the
  filter, or an equivalent compare-and-set. A read-then-write
  implementation does not satisfy the SPI.
- **`findReadyForProcessing` is explicitly non-exclusive.**
  Implementations need not lock rows or return disjoint sets.
  Concurrent workers may receive overlapping results; a worker that
  loses the claim skips the publication without invoking its listener.
- **Row locking is permitted, not expected.** A backend whose database
  makes `SKIP LOCKED`-style polling cheap may use it as an
  optimisation, but it may not rely on it for correctness — `tryClaim`
  must still be atomic on its own.

**Consequences**:

- Overlapping polls cost a wasted read, never a duplicate dispatch. The
  waste grows with worker count, so the current shape is sized for
  typical deployments (1–3 workers); scaling far past that is the point
  to revisit the poll, and it can be revisited without touching the
  claim contract.
- Backend authors have one atomicity obligation instead of two, and it
  maps onto a primitive every reasonable datastore has. MongoDB's
  `findOneAndUpdate` and Prisma's `updateMany` + count both satisfy it
  directly.
- The in-memory reference implementation is now consistent with the
  stated contract rather than an exception to it, which restores its
  value as the executable reference ADR-007 claims it is.
- ADR-007's `SPI contract` appendix and the
  `EventPublicationRepository` JSDoc are corrected in place and point
  here.

**See also**:

- [ADR-007 — Outbox architecture](../adr/007-outbox-architecture.md)
- [Outbox pattern overview](../architecture/outbox-pattern.md)
- [`@nestjs-transactional/outbox-typeorm` README](../../packages/outbox-typeorm/README.md)
