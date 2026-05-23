---
'@nestjs-transactional/core': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/outbox-typeorm': patch
'@nestjs-transactional/outbox-microservices': patch
---

Move the alpha dist-tag through a post-publish step in
`release.yml`.

The previous attempt added `--tag alpha` to the root `release`
script. `@changesets/cli publish` rejects that in pre-release mode
with "Releasing under custom tag is not allowed in pre mode"
([changesets/changesets#942](https://github.com/changesets/changesets/issues/942)),
so the publish step failed before any package reached npm.

The workflow now runs `changeset publish` without `--tag` (which
defaults to `latest`), and a follow-up step iterates
`steps.changesets.outputs.publishedPackages` and calls
`npm dist-tag add <name>@<version> alpha` for each. The freshly
published pre-releases land in both `latest` and `alpha`; subsequent
`npm install @nestjs-transactional/<pkg>@alpha` resolves to the
newest pre-release rather than to a stale `1.0.0-alpha.0`.

`publishConfig.tag = "alpha"` from a prior change stays in the
package manifests as declarative metadata for direct `npm publish`
callers. Both — the workflow step and the manifest field — become
no-ops after `pnpm changeset pre exit` for stable `1.0.0`.

No functional / API change — release infrastructure only.
