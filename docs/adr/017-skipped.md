# ADR-017: Skipped — number reserved during Phase 12/13 iteration

## Status

Skipped — number reserved, no decision recorded.

## Context

ADR numbering in this repository is monotonic and never reused.
Slot 017 was reserved during Phase 12 (package rename:
`@nestjs-transactional/outbox-core` → `@nestjs-transactional/outbox`,
see the supersession notes in [ADR-006](006-outbox-pattern.md)
and [ADR-007](007-outbox-architecture.md)) / Phase 13 era for
a decision that ended up not being captured as its own ADR.

The Phase 12 package rename was administrative — it didn't
change the architecture, only the npm name — and was recorded
as inline supersession notes on the ADRs whose body text used
the old name (006, 007). It didn't earn a standalone ADR.

The Phase 13 work folded into the Phase 14 multi-adapter
design captured by [ADR-018](018-multi-adapter-architecture.md)
and [ADR-019](019-outbox-multi-forroot-pattern.md). Whatever
in-flight design considerations had earmarked slot 017 either
landed in those ADRs or were absorbed into the design
decisions DD-020..DD-024 in `docs/dd/`.

This stub exists so a reader searching for `ADR-017` finds an
explicit "no content" record rather than a missing file.

## Where the decisions actually live

- [ADR-006](006-outbox-pattern.md) and
  [ADR-007](007-outbox-architecture.md) — both carry "Phase 12
  package rename" notes documenting the cosmetic change.
- [ADR-018](018-multi-adapter-architecture.md) — the Phase 14
  multi-adapter architecture which absorbed the Phase 13
  in-flight threads.
- [DD-020](../dd/020-multi-adapter-datasource-name.md) ..
  [DD-024](../dd/024-outbox-publisher-facade.md) — the design
  decisions complementary to ADR-018.

## Notes

- Number reuse is forbidden — same convention as
  [ADR-011](011-skipped.md), [ADR-012](012-skipped.md),
  [ADR-013](013-skipped.md). A future decision needing an ADR
  gets the next free integer, not this slot.
