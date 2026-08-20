---
'@nestjs-transactional/core': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/outbox-typeorm': patch
'@nestjs-transactional/outbox-microservices': patch
---

Fixes the `/testing` subpath for consumers on the default CommonJS
module resolution.

`@nestjs-transactional/core/testing` and
`@nestjs-transactional/outbox/testing` did not resolve to their type
declarations under `node10` resolution — which is what TypeScript
selects for `module: commonjs` when a project does not name
`moduleResolution` explicitly, and therefore what a stock NestJS
`tsconfig.json` gets. The import failed with:

```
error TS2307: Cannot find module '@nestjs-transactional/core/testing'
  or its corresponding type declarations.
  There are types at '.../dist/testing/index.d.ts', but this result
  could not be resolved under your current 'moduleResolution' setting.
```

`node10` predates `exports` maps and looks for `<pkg>/testing/` on
disk, so it never saw `dist/testing/index.d.ts`. Both packages now
declare `typesVersions` pointing at it, which is the supported way to
serve subpath types to that resolution mode.

**Runtime was never affected.** Node honours the `exports` map
regardless of the TypeScript setting, so `require()` and the built
JavaScript always worked; only type resolution failed. If you had
worked around this by setting `moduleResolution: "node16"` or by
importing from a deep path, neither is needed any more, and both keep
working.

Also on every package, from `publint`:

- `"type": "commonjs"` is now declared, making the intent explicit
  rather than leaving Node to detect it.
- `repository.url` carries the canonical `git+https://` prefix.

Both `publint` and `@arethetypeswrong/cli` now run in CI
(`pnpm publish:check`), which is how the subpath defect was found —
[ADR-004](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/004-public-api-stability.md)
had claimed for six alpha releases that they already did.
