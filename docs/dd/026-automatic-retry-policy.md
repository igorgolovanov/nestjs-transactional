# DD-026: Automatic retry is an opt-in scheduler, not a new lifecycle state

**Context**: A publication that fails has, until now, exactly one route
back: an operator calls `FailedEventPublications.resubmit(...)`. There is
no backoff, and nothing consumes `completionAttempts` automatically — a
permanently failing publication can be resubmitted forever, and a
transient failure needs a human (or a hand-written scheduled job) to
recover.

The post-alpha assessment recorded this as a production-readiness gap
(improvement-plan item C2) and assumed it was also a parity gap. Checking
the Spring Modulith reference corrected that: **Spring Modulith has no
automatic retry with backoff and no dead-letter state either.** Its model
is exactly ours — the staleness monitor marks stuck publications
`FAILED`, and recovery is `FailedEventPublications.resubmit` /
`IncompleteEventPublications.resubmitIncompletePublications` taking
`ResubmissionOptions` (`withBatchSize`, `withMinAge`, `withFilter`), with
"stop after N attempts" expressed as a filter over
`getCompletionAttempts()`. The five lifecycle states are the same five we
have.

So this is not a gap against the parity goal. It is a deliberate decision
about whether to go beyond it, and the useful question is how far.

**Alternatives considered**:

- **Stay at parity; ship a recipe instead of code.** Document a
  `@nestjs/schedule` cron in the examples that calls `resubmit` with a
  `completionAttempts` filter. Rejected as the primary answer: it leaves
  every user to reimplement backoff arithmetic, and the failure mode of
  getting it wrong (a tight retry loop against a downstream that is
  already struggling) is exactly what a framework should absorb. Kept as
  the fallback for anyone who wants full control.
- **Add a terminal `ABANDONED` / `DEAD` status.** Attractive for
  alerting — "what will never be retried" becomes one indexed status
  lookup instead of a compound predicate — and cheap to store, since
  `status` is a plain `varchar(32)` rather than a Postgres enum, so no
  migration is needed. Rejected anyway: it is a sixth state against
  Spring Modulith's five, every future backend
  (`outbox-prisma`, `outbox-mongodb`) and every operator dashboard has
  to learn it, and it silently changes what `findIncomplete()` means.
  Deferred rather than refused — if alerting pressure makes the compound
  predicate painful, this is the escalation, and it can be added without
  a schema change.
- **Fold retry into `EventPublicationProcessor`.** Rejected: the
  processor's job is to dispatch claimable work. Retry eligibility is a
  policy over failed work, on its own cadence. Merging them would also
  make the retry policy impossible to disable independently.
- **Add a `last_attempt_date` column** to compute backoff exactly.
  Rejected for now: it forces a migration on every existing deployment,
  and `lastResubmissionDate ?? publicationDate` is exact from the second
  retry onward (see Consequences for the one imprecise case).

**Decision**:

- **A separate, opt-in `OutboxRetryScheduler`**, shaped like
  `StalenessMonitor`: a self-rescheduling timer, per-dataSource,
  started and drained by `OutboxProcessingModule`. It reuses the same
  self-rescheduling-`setTimeout` pattern and the same bounded shutdown
  drain as the other workers (item C1), so it adds no new concurrency
  model.
- **Off by default**, following the `StalenessConfig` convention where
  `0` disables: `maxAttempts: 0` means no automatic retry, and the timer
  is never scheduled. Nothing changes for existing deployments unless
  they ask for it.
- **Built on the operator API, not beside it.** The scheduler calls
  `FailedEventPublications.resubmit(ResubmissionOptions…)` with a
  backoff predicate as the filter. Automatic retry is therefore
  literally "a scheduler over the API Spring Modulith expects you to
  drive by hand" — the parity story stays intact, and there is one
  resubmission code path rather than two.
- **No new lifecycle state.** A publication whose `completionAttempts`
  has reached `maxAttempts` simply stops being selected. It stays
  `FAILED`, queryable through the existing
  `FailedEventPublications.findAll({ minAge, maxAttempts })`, and an
  operator can still resubmit it manually — the policy caps the
  *automatic* path, it does not seal the record.
- **Backoff without a schema change.** Eligibility is
  `now - (lastResubmissionDate ?? publicationDate) >= delay(attempts)`,
  where `delay = min(baseDelay * factor^(attempts-1), maxDelay)`,
  optionally spread by `jitter`.
- **`ResubmissionOptions.maxInFlight` is removed** (improvement-plan
  item A5). It was declared, never read, and has no counterpart in
  Spring Modulith. `resubmit` only issues cheap status updates; the
  quantities that actually bound load are `batchSize` here and
  `maxConcurrent` on the processor.

**Consequences**:

- Transient failures recover without human involvement, and a
  permanently failing publication stops consuming retry budget after
  `maxAttempts` instead of cycling forever.
- **The first retry after a failure can fire early.** With no failure
  timestamp, `lastAttemptAt` falls back to `publicationDate`, so a
  publication that sat healthy for an hour and then failed is
  immediately past its first backoff window. It is retried once, which
  stamps `lastResubmissionDate`, and every subsequent interval is exact.
  Accepted: one eager retry is cheaper than a migration, and the
  scheduler's own `interval` still bounds how often it can happen.
- Retries are at-least-once, like every other path here. A resubmitted
  publication goes back through `tryClaim`, so concurrent schedulers
  cannot cause a double dispatch (DD-025) — duplicate resubmission is
  a wasted `UPDATE`, not a duplicate delivery.
- "What will never be retried again" is a compound query
  (`status = FAILED AND completion_attempts >= maxAttempts`) rather
  than a status lookup, and the answer moves if `maxAttempts` is
  reconfigured. That is a real ergonomic cost, consciously taken, and
  the escalation path is the deferred `ABANDONED` state above.
- Removing `maxInFlight` is a breaking change to a published (alpha)
  API surface. It ships with a changeset; the builder method and the
  getter both go.

**See also**:

- [DD-025 — the claim carries the concurrency guarantee](025-claim-atomicity-obligation.md)
- [DD-009 — Event Publication Registry](009-event-publication-registry.md)
- [ADR-006 — Outbox pattern rationale](../adr/006-outbox-pattern.md)
- [Spring Modulith reference — Event Publication Registry](https://docs.spring.io/spring-modulith/reference/events.html)
- [Improvement plan, item C2](../roadmap/improvement-plan.md)
