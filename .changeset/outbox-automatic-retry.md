---
'@nestjs-transactional/outbox': minor
---

Optional automatic retry for `FAILED` publications, and removal of the
dead `ResubmissionOptions.maxInFlight` option.

Recovery used to be entirely operator-driven: someone had to call
`FailedEventPublications.resubmit(...)`, there was no backoff, and
nothing consumed `completionAttempts`, so a permanently failing
publication could be resubmitted forever. Checking the Spring Modulith
reference while designing this turned up something worth stating plainly:
**Spring Modulith has no automatic retry or dead-letter state either.**
Its model is the one we already had. So this is not a parity fix — it is
a deliberate step past parity, and it is opt-in.

`OutboxRetryScheduler` resubmits failed publications whose backoff window
has elapsed, on its own interval, and stops selecting a publication once
it has used up its attempts. Configure it through the new `retry` option
on `OutboxModule.forRoot` / `forRootAsync`:

```ts
OutboxModule.forRoot({
  retry: {
    maxAttempts: 3,     // counts the first delivery: original + 2 retries
    interval: 60_000,
    baseDelay: 1_000,
    factor: 2,          // baseDelay * factor^(attempts - 1)
    maxDelay: 300_000,
    jitter: 0.2,        // spread retries after a mass failure
    batchSize: 100,
  },
});
```

**Off unless you ask for it.** `maxAttempts` defaults to `0`, which means
no automatic retry and no timer is ever scheduled — the same "0 disables"
convention `StalenessConfig` uses. Existing deployments behave exactly as
before.

**No new lifecycle state.** A publication that exhausts its attempts
stays `FAILED`, still listed by `FailedEventPublications.findAll(...)`,
and an operator can still resubmit it by hand; the cap bounds the
automatic path only. The cost of that choice is that "will never be
retried again" is a compound query rather than a status lookup — see
DD-026 for why a sixth state was deferred rather than added.

**Built on the operator API, not beside it.** The scheduler calls
`resubmit()` with a backoff predicate as its filter, so there is one
resubmission code path, and anything the scheduler does you can do
yourself from your own cron if you want different selection logic.

Backoff needs no schema change: eligibility is measured from
`lastResubmissionDate ?? publicationDate`. The one imprecision is that a
publication which lived a long time before failing is immediately due for
its *first* retry, since there is no failure timestamp to measure from.
Every later window is exact.

**Breaking:** `ResubmissionOptions.maxInFlight` and `withMaxInFlight()`
are removed. The option was declared but never read, and has no
counterpart in Spring Modulith. `resubmit` only issues cheap status
updates; the quantities that actually bound load are `batchSize` here and
`maxConcurrent` on the processor.
