---
'@nestjs-transactional/core': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/outbox-typeorm': patch
'@nestjs-transactional/outbox-microservices': patch
---

Pin npm dist-tag to `alpha` while in the pre-release cohort.

Each package's `publishConfig` now declares `"tag": "alpha"`, so
`npm publish` (driven by `changesets/action` from the Release
workflow) places every pre-release into the `alpha` dist-tag instead
of `latest`. Previously the `release` script (`changeset publish`)
did not pass `--tag`, and changesets does not infer the pre-release
tag automatically — so the second and every subsequent
pre-release publish wrote the new version into `latest`, leaving
the `alpha` tag pointing at `1.0.0-alpha.0` while `latest` advanced
to the freshest pre-release. That was already the case on
`@nestjs-transactional/typeorm` and `@nestjs-transactional/outbox-typeorm`
after the TypeORM 1.0 bump (`1.0.0-alpha.0` → `1.0.0-alpha.1`) and on
`@nestjs-transactional/cqrs` after ADR-020 (`1.0.0-alpha.0` →
`1.0.0-alpha.2`); manual `npm dist-tag` runs corrected the registry.

`publishConfig.tag` is declarative per-package and survives
`changesets/action` updates without changes to the release workflow
or root scripts. The setting will be removed (or flipped to `latest`)
as part of the `pnpm changeset pre exit` step before promoting the
cohort to stable `1.0.0`.

No functional change to any package's runtime behaviour or public
API — `package.json` metadata only.
