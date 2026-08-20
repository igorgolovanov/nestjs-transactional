---
'@nestjs-transactional/outbox': minor
---

Shutdown now drains in-flight outbox work instead of abandoning it.

`OutboxProcessingModule.onApplicationShutdown` used to be synchronous:
it set `running = false` and cancelled the next-poll `setTimeout`, but
did not await the `processBatch()` already dispatched by the previous
tick. NestJS moved straight on to destroying providers — the TypeORM
`DataSource` among them — so an in-flight `processOne()` writing
`PROCESSING → COMPLETED` could race the connection-pool teardown and
leave the row stuck in `PROCESSING` until the staleness monitor
recovered it on a later boot.

`EventPublicationProcessor.stop()` and `StalenessMonitor.stop()` are now
`async` and await the work already in flight; the module hook awaits all
of them concurrently, so multi-dataSource deployments do not add up
their budgets. An idle worker still resolves immediately — the drain
costs nothing when there is nothing to drain.

Two new options bound the wait: `processor.shutdownTimeout` and
`staleness.shutdownTimeout`, both defaulting to the exported
`DEFAULT_DRAIN_TIMEOUT_MS` (10 s, sized so a 30-second platform grace
period still has room for the pool to close and logs to flush). Set
either to `0` to restore the previous no-wait behaviour.

Work abandoned at the deadline is abandoned, not cancelled — there is no
safe way to interrupt a half-finished listener invocation. The trade-off
is deliberate: shutdown latency against recovery lag, never durability.
A publication left in `PROCESSING` is still recovered by the staleness
monitor, whereas blocking a deployment indefinitely on a stuck listener
would be the worse failure.

**Migration.** If you wrote a user-side drain service against the old
behaviour (convention #24 documented one, and the `graceful-shutdown`
example shipped it), delete it and set `shutdownTimeout` instead. Two
drains racing each other is harder to reason about than one.

`stop()` returning `Promise<void>` rather than `void` is technically a
signature change; callers that ignore the result are unaffected at
runtime.
