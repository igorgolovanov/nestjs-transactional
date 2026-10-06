---
'@nestjs-transactional/cqrs': major
---

Phases and the outbox are scheduled when an event is published

`EventBus.publish` now schedules an event's transaction phases and, for
an `@Externalized` event, the outbox at once, inside the publishing
transaction, before a wrapping publisher such as `WorkflowsCqrsModule`'s
runs. Such a publisher forwards the event only after its own write, and
not at all when that write fails. Before, an `AFTER_ROLLBACK` handler
could then miss the rollback, and an event of a rolled-back transaction
reached the outbox bridge after the transaction ended, which logged it
as dropped. DD-029, point 4.
