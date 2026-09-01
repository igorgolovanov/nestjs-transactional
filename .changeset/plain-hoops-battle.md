---
'@nestjs-transactional/outbox': minor
'@nestjs-transactional/outbox-typeorm': minor
---

Scheduled retention for completed publications. `OutboxModule.forRoot({ cleanup: { interval, retention, batchSize } })` starts a per-dataSource job that deletes publications whose `completionDate` is older than the retention window. Off by default; `interval: 0` keeps it off, and `CompletedEventPublications.purge(...)` stays available for a one-shot purge.

`EventPublicationRepository.findCompleted` now documents and guarantees oldest-first ordering, and both repositories were aligned to it. The order was previously unspecified: the TypeORM repository returned newest-first, the in-memory one returned insertion order, and no test pinned either. It becomes a contract because `limit` makes it one — a bounded retention pass reading newest-first would delete only recent rows and never reach the old ones. If you relied on `CompletedEventPublications.findAll(...)` returning newest-first, sort at the call site.
