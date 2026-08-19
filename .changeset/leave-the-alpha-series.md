---
'@nestjs-transactional/core': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/outbox-typeorm': patch
'@nestjs-transactional/outbox-microservices': patch
---

`1.0.0` — the packages leave the alpha series.

`npm install @nestjs-transactional/core` now resolves to a stable
release. Until now it returned nothing useful without an explicit
`@alpha`, because the manifests pinned the `alpha` dist-tag; that pin is
gone and publishing goes to `latest`.

The alpha labels are gone from the READMEs too, along with the claim
that the API "may change between 0.x releases" — which was doubly wrong,
since the cohort never sat on `0.x`. From here the surface is under
[ADR-004](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/004-public-api-stability.md):
a breaking change costs a major bump *and* an ADR explaining it.

That promise is machine-checked rather than asserted. The committed
api-extractor reports under `packages/*/etc/*.api.md` turn any change to
the published surface into a reviewable diff, and `publint` plus
`@arethetypeswrong/cli` verify on every CI run that what a consumer
resolves from the tarball matches what the sources declare.
