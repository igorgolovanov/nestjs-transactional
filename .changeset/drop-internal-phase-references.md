---
'@nestjs-transactional/core': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/outbox-typeorm': patch
'@nestjs-transactional/outbox-microservices': patch
---

Removed internal phase numbers from the published API documentation.

The JSDoc carried 90 references to this project's internal roadmap
phases, and 52 of them reached the shipped `.d.ts` files — so hovering
`TransactionalModule.forRoot` in an editor produced "mirrors Phase 14.3.2
`OutboxModule` per ADR-019", and `@Externalized`'s docs mentioned "Phase
11.3". None of that means anything to someone consuming the library.

Where the number stood in for a feature, it is replaced by the feature's
name ("transparent transactional repositories", "per-dataSource handler
routing", "event externalization"); where it was pure bookkeeping, the
parenthetical is gone. No behaviour, signature, or type changed —
`.d.ts` output differs only in comments.

Two stale statements surfaced while doing this and were corrected rather
than relabelled: `OutboxListenerRegistry` claimed the scanner that
populates it was an "upcoming" iteration (it shipped long ago), and a
multi-dataSource spec claimed per-dataSource listener routing was still
pending. Also user-visible: the runtime warning about
`headers`/`routingKey` not reaching the wire payload no longer cites a
phase number.

Phase numbering is retained where it does real work: `docs/roadmap/`
(which is the phase history), and the ADR/DD status headers and revision
histories, where phase anchors stand in for dates by convention.
