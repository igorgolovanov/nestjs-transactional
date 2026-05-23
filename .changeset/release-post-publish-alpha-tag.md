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

Two guards prevent the step from tagging stable versions as
`alpha` after `pnpm changeset pre exit`:

1. `if: hashFiles('.changeset/pre.json') != ''` — primary gate.
   `pre.json` exists only while the cohort is in pre-release mode;
   the file is removed by `changeset pre exit`.
2. Per-version skip on a missing prerelease segment (no `-` in the
   semver) — safety net for a mixed publish run or a misconfigured
   pre-exit.

`publishConfig.tag = "alpha"` from a prior change stays in the
package manifests as declarative metadata for direct `npm publish`
callers. Both — the workflow step and the manifest field — become
no-ops after `pnpm changeset pre exit` for stable `1.0.0`.

No functional / API change — release infrastructure only.
