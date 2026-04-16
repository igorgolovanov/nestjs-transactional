# ADR-011: Skipped — number reserved during Phase 8/9 iteration

## Status

Skipped — number reserved, no decision recorded.

## Context

ADR numbering in this repository is monotonic and never reused.
Slots 011, 012, and 013 were reserved during Phase 8 (testing
utilities) and Phase 9 (documentation and release) iterations
for decisions that ended up being captured elsewhere — either
absorbed into [ADR-014](014-handler-api-redesign.md) (which
swept up the listener / handler design space at the end of
Phase 9) or recorded as design decisions in `docs/dd/`
([DD-011](../dd/011-hybrid-event-publishing.md) hybrid event
publishing, [DD-012](../dd/012-integration-events-handler.md)
`@IntegrationEventsHandler` as smart default,
[DD-013](../dd/013-class-level-handler-api.md) class-level
handler API alignment).

This stub exists so the numbering contract is preserved: a
reader who searches for `ADR-011` finds an explicit "no
content" record rather than a missing file.

## Where the decisions actually live

- Phase 8 (testing utilities) — see
  [`docs/roadmap/README.md`](../roadmap/README.md) "Phase 8"
  entry and `packages/outbox/src/testing/` source. No
  decisions at this point rose to ADR weight; the testing
  utilities follow the existing patterns established in
  ADR-005 (method wrapping) and ADR-007 (outbox
  architecture).
- Phase 9 / Phase 10 (release prep + class-level handler
  redesign) — [ADR-014](014-handler-api-redesign.md) is the
  canonical record. [DD-013](../dd/013-class-level-handler-api.md)
  complements it.

## Notes

- Number reuse is forbidden — even if a future decision needs
  an ADR, it gets the next free integer (currently 020+), not
  this slot.
- Same convention applies to ADR-012, ADR-013, and ADR-017.
