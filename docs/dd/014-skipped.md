# DD-014: Skipped — number reserved during Phase 9/10 iteration

**Status**: Skipped — number reserved, no decision recorded.

**Context**: DD numbering in this repository is monotonic and never
reused. Slots DD-014 and DD-015 were reserved during the Phase 9/10
iteration (release prep + class-level handler redesign) for
decisions that ended up either captured in
[ADR-014](../adr/014-handler-api-redesign.md) directly or rolled
forward into the multi-adapter design (DD-020..DD-024).

This stub exists so a reader searching for DD-014 finds an explicit
"no content" record rather than a missing file.

**Where the decisions actually live**:
- [ADR-014](../adr/014-handler-api-redesign.md) — class-level handler
  API redesign, Phase 10.
- [DD-013](013-class-level-handler-api.md) — the surviving DD record
  for the redesign.

**Notes**: Number reuse is forbidden — even if a future decision
needs a DD slot, it gets the next free integer (currently 025+),
not this slot. Same convention applies to DD-015.
