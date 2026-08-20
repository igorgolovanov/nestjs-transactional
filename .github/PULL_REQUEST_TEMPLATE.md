<!--
Keep this short. The checklist below is the same one CONTRIBUTING and
AGENTS.md describe; it is here so nothing is remembered from memory.
-->

## What this changes

<!-- The behaviour that differs afterwards, not a list of files. -->

## Why

<!--
If it fixes an issue, link it. If it implements a decision, cite the
ADR / DD. If the decision does not exist yet and the change is
architectural, it probably wants to be a DD first — see the DO NOT
cheat-sheet in AGENTS.md.
-->

## Checklist

- [ ] Tests cover the change, and they fail without it
- [ ] `pnpm -r test` and `pnpm -r test:integration` green
- [ ] `pnpm -r build` and `pnpm -r lint` clean
- [ ] `pnpm lint:doc-links` clean, if any markdown moved
- [ ] Changeset added (`pnpm changeset`) for anything user-facing —
      including a behaviour change under an unchanged signature
- [ ] Docs updated where they described the old behaviour: README,
      JSDoc, `docs/known-limitations.md`
- [ ] ADR or DD added for an architectural decision, or the existing
      one amended

<!--
Two things reviewers here check that are easy to miss:

- A test that passes against the unfixed code proves nothing. Break the
  implementation on purpose and confirm the test notices.
- A doc that promises behaviour the code does not have is a defect, not
  a cosmetic issue. Several past releases shipped exactly that.
-->
