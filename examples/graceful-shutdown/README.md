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
         │     │     processor.stop()  (sync, sets running=false,
         │     │                        cancels next setTimeout)
         │     │
         │     ├─ OutboxDrainService.onApplicationShutdown
         │     │     processor.stop()  (idempotent re-call)
         │     │     poll findIncomplete() until status===PROCESSING
         │     │       count is 0, OR DRAIN_TIMEOUT_MS elapses
         │     │
         │     └─ ExampleCleanupService.onApplicationShutdown
         │           your custom cleanup runs here
         │                        │
         │ 4. provider dispose    │
         │     DataSource pool    │  ← closed AFTER drain returns,
         │     closes here        │    so in-flight queries finish
         └────────────────────────┘
```

## What's the gap that `OutboxDrainService` plugs?

The framework's `OutboxProcessingModule.onApplicationShutdown`
calls `processor.stop()`, which:

- Sets the `running = false` flag (no more polls scheduled).
- Cancels the pending `setTimeout` for the next batch.

It does NOT await the `processBatch()` Promise that's already
in flight from the previous tick. NestJS keeps walking through
`onApplicationShutdown` hooks and then disposes providers — at
which point TypeORM's `DataSource` calls `pool.end()`. If the
in-flight `processOne` is still running its `PROCESSING →
COMPLETED` status update, the pool teardown can race the update,
leaving the row stuck in `PROCESSING`. The staleness monitor
recovers it on the next boot, but a clean drain avoids that
back-pressure entirely.

[`OutboxDrainService`](src/shutdown/outbox-drain.service.ts) is
the user-side complement: an async `OnApplicationShutdown` that
polls `findIncomplete()` until no row is in `PROCESSING`, with
a configurable timeout (default 10 s) so a genuinely-stuck
handler doesn't block deployment indefinitely. Pair this with
the platform's grace period (e.g. Kubernetes' default 30 s) and
you get a deterministic drain envelope.

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
Draining outbox (signal=SIGTERM)…
Outbox drained cleanly in 412ms
ExampleCleanupService done (signal=SIGTERM)
[TypeOrmModule] Database connection closed
```

`Ctrl+C` in the foreground works too — Node maps it to `SIGINT`,
which `app.enableShutdownHooks()` registers alongside `SIGTERM`.

## What it shows (verified by integration tests)

1. **Idle shutdown is uneventful.** `app.close()` from a quiet
   state walks every `OnApplicationShutdown` hook (framework +
   user) and resolves cleanly. No in-flight work, nothing to
   wait on, but the user-side cleanup STILL runs — that's the
   contract.
2. **In-flight handler invocations complete before the
   DataSource closes.** The slow archival handler takes 400 ms
   per event. The test triggers one event, waits for the handler
   to start (`started === 1, finished === 0`), then calls
   `app.close()`. Total close duration covers the remaining
   handler latency, the publication ends up `COMPLETED` (not
   `PROCESSING`), and `OutboxDrainService.drained` is `true`.
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
- **No timeout on the drain poll.** A genuinely-stuck handler
  (deadlocked, waiting on an external service that's also
  shutting down) would block deployment forever. The
  10-second default in `DRAIN_TIMEOUT_MS` is a safety valve;
  past that, the staleness monitor recovers stuck rows on the
  next boot. Tune it to your platform's grace period (e.g.
  Kubernetes' `terminationGracePeriodSeconds` minus a few
  seconds for everything else to wind down).
- **Relying on hook ordering between sibling providers.**
  NestJS calls hooks in REVERSE module-init order, but within
  a module the order between sibling providers isn't
  documented. The example's `OutboxDrainService` calls
  `processor.stop()` itself BEFORE polling, so it doesn't care
  whether `OutboxProcessingModule.onApplicationShutdown` ran
  first or not.

## Related examples

- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — the
  simpler baseline. Compare to see what shutdown wiring adds.
- [`async-config-from-environment`](../async-config-from-environment)
  — Tier 5 sibling. `DRAIN_TIMEOUT_MS` is a great candidate to
  surface as a `forRootAsync`-injected env var in a real app
  (the example here keeps it as a constant for clarity).
- [`e-commerce-orders`](../e-commerce-orders) — Tier 5
  flagship. The shutdown pattern here applies verbatim to
  the multi-DS deployment there: register one
  `OutboxDrainService` per dataSource, or generalise it to
  iterate over every `EventPublicationProcessor`.

## Further reading

- NestJS lifecycle hooks:
  https://docs.nestjs.com/fundamentals/lifecycle-events
- Kubernetes pod termination:
  https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination
- [DD-019 — single-unit atomicity invariant](../../docs/dd/019-single-unit-atomicity.md)
