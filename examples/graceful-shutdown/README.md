# graceful-shutdown

**Tier 5 — Production realism.** What happens when your pod
receives `SIGTERM`. The framework's outbox worker stops accepting
new batches, in-flight handler invocations finish cleanly, the
underlying `@Transactional()` commits land before the DataSource
pool closes, and user-defined `OnApplicationShutdown` hooks
(metrics flush, cache cleanup, …) fire alongside the framework's
own. This example wires it all up and pins the contract with four
integration tests.

## When to use this example

- Your service runs in Kubernetes / Nomad / ECS — anything that
  sends `SIGTERM` and waits a `terminationGracePeriodSeconds` window
  before `SIGKILL`. You need to know the framework drains
  cleanly inside that window.
- You're running the outbox worker in-process (the default
  `OutboxProcessingModule` shape) and need to make sure rolling
  deploys don't leave publications stuck in `PROCESSING`.
- You're standing up a new app and want a copy-paste shutdown
  pattern: drain timeout, signal handling, lifecycle ordering.

## Architecture

```
                 SIGTERM
                    │
                    ▼
      app.enableShutdownHooks() — translates the OS signal
                    │              into a Nest lifecycle event
                    ▼
         ┌────────────────────────┐
         │ NestJS shutdown chain  │  reverse-init order:
         │                        │
         │ 1. onModuleDestroy     │
         │ 2. beforeApplicationShutdown
         │ 3. onApplicationShutdown
         │     │                  │
         │     ├─ OutboxProcessingModule.onApplicationShutdown
         │     │     await processor.stop()   sets running=false,
         │     │       cancels the next setTimeout, then awaits the
         │     │       batch already in flight — bounded by
         │     │       processor.shutdownTimeout
         │     │     await monitor.stop()     same, for the sweep
         │     │
         │     └─ ExampleCleanupService.onApplicationShutdown
         │           your custom cleanup runs here
         │                        │
         │ 4. provider dispose    │
         │     DataSource pool    │  ← closed AFTER drain returns,
         │     closes here        │    so in-flight queries finish
         └────────────────────────┘
```

## How the drain works

`OutboxProcessingModule.onApplicationShutdown` awaits
`processor.stop()` and `monitor.stop()`. Each of those:

- Sets `running = false`, so no further poll is scheduled.
- Cancels the pending `setTimeout` for the next batch.
- **Awaits the work already in flight** from the previous tick,
  bounded by `processor.shutdownTimeout` /
  `staleness.shutdownTimeout`.

That last step is the load-bearing one. Without it, NestJS walks
on through the remaining hooks and disposes providers — at which
point TypeORM's `DataSource` calls `pool.end()`. An in-flight
`processOne` still running its `PROCESSING → COMPLETED` update
would race the pool teardown and leave the row stuck in
`PROCESSING`, waiting for the staleness monitor to recover it on
a later boot.

The timeout is the safety valve: a genuinely stuck handler
(deadlocked, or waiting on a service that is also shutting down)
must not block a deployment forever. Set it below the platform's
grace period — Kubernetes' `terminationGracePeriodSeconds`
defaults to 30 s, so 10 s of drain leaves room for the pool to
close and logs to flush. Past the deadline the batch is abandoned,
not cancelled: whatever it left in `PROCESSING` is recovered on the
next boot. This trades shutdown latency against recovery lag,
never durability.

Earlier versions of this example shipped a user-side
`OutboxDrainService` that polled `findIncomplete()` until nothing
was `PROCESSING`, because the framework hook was synchronous. That
workaround is gone — if you carried it into your own app, you can
delete it and set `shutdownTimeout` instead.

## Prerequisites

- **Docker Desktop / Colima / Rancher Desktop running.**
  Integration tests pull `postgres:16-alpine` (~30 MB) on first
  run via testcontainers.
- For `pnpm start`: a Postgres 16 instance reachable on
  `localhost:5432`.

## Run

```bash
pnpm install                                    # from monorepo root

# Integration tests (Docker required) — preferred:
pnpm -C examples/graceful-shutdown test:integration

# Unit tests (none currently; passWithNoTests for symmetry):
pnpm -C examples/graceful-shutdown test

# Visual demo:
createdb graceful_demo                          # one-time
PGDATABASE=graceful_demo pnpm -C examples/graceful-shutdown start
# In another terminal:
kill -TERM $(pgrep -f graceful-shutdown/dist/main.js)
```

You should see, in this order:

```
EventPublicationProcessor stopped
ExampleCleanupService done (signal=SIGTERM)
[TypeOrmModule] Database connection closed
```

The `stopped` line appears only after the in-flight batch has
finished — the drain happens before it is logged, not after.

`Ctrl+C` in the foreground works too — Node maps it to `SIGINT`,
which `app.enableShutdownHooks()` registers alongside `SIGTERM`.

## What it shows (verified by integration tests)

1. **Idle shutdown is uneventful.** `app.close()` from a quiet
   state walks every `OnApplicationShutdown` hook (framework +
   user) and resolves cleanly. Nothing is in flight, so the drain
   costs nothing — the test asserts close takes under a second —
   and the user-side cleanup STILL runs. That's the contract.
2. **In-flight handler invocations complete before the
   DataSource closes.** The slow archival handler takes 400 ms
   per event. The test triggers one event, waits for the handler
   to start (`started === 1, finished === 0`), then calls
   `app.close()`. Total close duration covers the remaining
   handler latency and the publication ends up `COMPLETED`, not
   `PROCESSING` — verified through a side pg client, since the
   Nest-managed DataSource is closed by then.
3. **Single-unit atomicity holds across shutdown.** A
   `recordEvent()` (one `@Transactional()` writing both an
   `audit_log` row and an `event_publication` row) is fired
   concurrently with `app.close()`. Both rows persist (DD-019).
4. **User-defined hooks fire alongside framework hooks.**
   `ExampleCleanupService.onApplicationShutdown` runs to
   completion during `app.close()` — proven via a public
   `cleaned` flag the test asserts on.

## Common pitfalls

- **Forgetting `app.enableShutdownHooks()`.** Without it,
  `SIGTERM` kills the process immediately — no
  `OnApplicationShutdown` runs, the worker is interrupted
  mid-batch, the connection pool isn't closed gracefully,
  publications are left in `PROCESSING`. The line is one call
  in `main.ts`, but it's *load-bearing*. Most "shutdown is
  flaky" reports trace back to this missing line.
- **Returning a non-awaited Promise from `OnApplicationShutdown`.**
  `void someAsyncWork()` looks like it works in dev, then in
  prod the async work gets cut short because NestJS only awaits
  the *returned* Promise. Always `return` or `await` async
  cleanup work directly so NestJS knows to wait.
- **Putting a long-running drain in `onModuleDestroy` instead
  of `onApplicationShutdown`.** `onModuleDestroy` runs FIRST
  in the shutdown chain — at that point the DataSource is
  still alive but other modules' state may already be
  destroyed. `onApplicationShutdown` runs LAST among lifecycle
  hooks, after every module has had a chance to settle. Drain
  there.
- **Setting `shutdownTimeout: 0` to make shutdown fast.** That
  restores the pre-drain behaviour: the batch in flight is
  abandoned immediately, and its publications sit in `PROCESSING`
  until the staleness monitor picks them up. Fine if you *want*
  the old semantics; surprising if you set it for speed and then
  wonder why rows keep needing recovery.
- **Setting `shutdownTimeout` above the platform's grace
  period.** The platform will `SIGKILL` mid-drain, which is
  strictly worse than a bounded abandon — you lose the pool
  teardown and log flush too. Keep the budget under the grace
  period with margin.
- **Writing your own drain service.** Not needed any more, and
  two drains racing each other is harder to reason about than
  one. Use `shutdownTimeout`.

## Related examples

- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — the
  simpler baseline. Compare to see what shutdown wiring adds.
- [`async-config-from-environment`](../async-config-from-environment)
  — Tier 5 sibling. `shutdownTimeout` is a good candidate to
  surface as a `forRootAsync`-injected env var in a real app, so
  the drain budget can track each environment's grace period (the
  example here hard-codes it for clarity).
- [`e-commerce-orders`](../e-commerce-orders) — Tier 5
  flagship. Nothing extra to wire there: the module drains every
  configured processor and monitor, so multi-dataSource
  deployments get the same behaviour, and the drains run
  concurrently rather than adding up their budgets.

## Further reading

- NestJS lifecycle hooks:
  https://docs.nestjs.com/fundamentals/lifecycle-events
- Kubernetes pod termination:
  https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination
- [DD-019 — single-unit atomicity invariant](../../docs/dd/019-hybrid-delivery-atomicity.md)
