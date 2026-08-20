---
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/outbox-typeorm': patch
---

TypeORM 1.1.0 is now the version the adapters are developed and tested
against.

**The peer range is unchanged** — `^0.3.0 || ^1.0.0` already admitted
`1.1.0`, so no consumer needs to do anything. What changes is that the
version is now verified rather than merely permitted: the workspace
lockfile pins `1.1.0`, and CI runs the full unit and integration matrix
(testcontainers Postgres) against three explicit points of the range —
`0.3.31` (newest `0.3.x`), `1.0.0` (the floor of `^1.0.0`) and `1.1.0`.

The upgrade needed no production-code changes. TypeORM 1.1.0 is a minor
release with no breaking changes, and the assumptions the adapter relies
on held: the prototype-patching contract tests, the
`driver.transactionSupport` capability check behind
`PropagationMode.NESTED`, and `SET TRANSACTION READ ONLY` all pass
unchanged on `0.3.31`, `1.0.0` and `1.1.0`.

Two related fixes on the way there:

- CI's matrix legs used to derive the `0.3` version from the lockfile
  rather than stating it, so bumping the lockfile would have turned that
  leg into a duplicate of another without anyone noticing. Every leg now
  names its version, and a post-install step asserts the version that
  actually resolved — `pnpm.overrides` in `package.json` is silently
  ignored by pnpm 10, and a silently-ignored override would leave the leg
  claiming a compatibility it never exercised.
- `@nestjs-transactional/cqrs` used `typeorm`, `@nestjs/typeorm`,
  `@nestjs/testing` and `@nestjs-transactional/typeorm` in its specs
  without declaring any of them, resolving them through the workspace's
  `public-hoist-pattern` instead. That worked only while every package
  happened to resolve the same TypeORM copy; with two versions in the
  tree its E2E suite injected a `DataSource` class from one copy and
  looked it up from another. Development-only, no effect on the
  published package.
