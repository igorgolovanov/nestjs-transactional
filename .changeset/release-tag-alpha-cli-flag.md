---
'@nestjs-transactional/core': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/outbox-typeorm': patch
'@nestjs-transactional/outbox-microservices': patch
---

Pass `--tag alpha` to `changeset publish` in the release script.

Previous attempt declared `publishConfig.tag = "alpha"` in each
package's `package.json`. The metadata reached the npm registry,
but `@changesets/cli publish` overrides it with its own `--tag`
argument (defaulting to `latest`), so every pre-release after
`1.0.0-alpha.0` continued to land in the `latest` dist-tag while
`alpha` stayed pinned to the initial version.

The fix is a single CLI flag in the root `release` script:

```diff
- "release": "changeset publish"
+ "release": "changeset publish --tag alpha"
```

`changesets/action` invokes this script from the Release workflow,
so the flag propagates to every package in the same publish run.
The previously-added `publishConfig.tag` stays in place as
declarative metadata for direct `npm publish` callers (where it
still applies); it will be removed alongside the `--tag alpha`
flag during `pnpm changeset pre exit` for stable `1.0.0`.

No functional / API change — release infrastructure only.
