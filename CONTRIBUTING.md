# Contributing to @nestjs-transactional

Thanks for your interest. This document captures the conventions used
across the monorepo. If any of it is out of date, please open an issue
or a PR — stale instructions are worse than none.

## Development environment

Requirements:

- **Node.js 20.11+** (latest LTS is fine). Node 22 is covered by CI.
- **pnpm 9+**. Any pnpm 9 release works; the repo pins
  `packageManager` in `package.json`.
- **Docker** — only for running TypeORM integration tests against a
  real Postgres via `testcontainers`. Unit and end-to-end tests run
  against `sql.js` and need no Docker.

Setup:

```bash
pnpm install
pnpm -r --filter './packages/*' build
pnpm -r --filter './packages/*' test
```

All three of these should succeed on a clean clone.

## Running tests and gates

From the repository root:

```bash
# Full test suite (unit + integration-style, no Docker required)
pnpm test

# Lint (ESLint)
pnpm lint

# Type check (tsc --build, no emit)
pnpm typecheck

# Prettier formatting
pnpm format:check    # verify — CI fails if dirty
pnpm format          # rewrite

# TypeORM integration tests (requires Docker)
pnpm --filter @nestjs-transactional/typeorm test:integration
```

Working on a single package:

```bash
pnpm --filter @nestjs-transactional/core test:watch
pnpm --filter @nestjs-transactional/typeorm build
```

Running an example:

```bash
pnpm -C examples/basic-usage start
pnpm -C examples/multi-datasource start
pnpm -C examples/cqrs-full-stack start
```

## Creating a changeset for your PR

Every user-visible change must ship with a changeset entry — it drives
the automated version bumps and the generated `CHANGELOG.md`.

```bash
pnpm changeset
```

The CLI will ask:

1. Which package(s) are affected.
2. Bump type per package: `patch`, `minor`, or `major`.
3. A one-paragraph summary aimed at downstream users (what changed,
   not why or how — that belongs in the PR body and commit messages).

Commit the generated `.changeset/*.md` file with your PR. On merge to
`main`, the release workflow opens (or updates) a "Version Packages"
PR that bumps versions and writes the changelog. Merging that PR
publishes to npm.

### When to skip a changeset

A changeset is NOT required for:

- Documentation-only edits (README, ADRs, JSDoc clarifications).
- Internal refactors with no public API change.
- Test-only changes.
- Tooling changes (CI, eslint config, prettier).
- Changes to the examples (the `examples/*` packages are `private: true`
  and never publish).

If in doubt, add one — an empty-content changeset is better than a
missed bump.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/). The scope
is usually the package name:

```
feat(core): add NESTED propagation savepoint rollback semantics
fix(typeorm): release savepoint on happy path even if entityManager throws
docs: update getting-started example for CqrsTransactionalModule
refactor(cqrs): extract event-type lookup into a private method
test(core): cover REQUIRES_NEW edge cases when suspension fails
chore: update @nestjs/common peer range to ^11
```

Breaking changes: append `!` to the type (`feat(core)!: ...`) or put
`BREAKING CHANGE:` in the body.

## Code style

- **TypeScript strict mode**. All types explicit; `any` is banned
  (`@typescript-eslint/no-explicit-any` is `error` on non-test code).
- **No emojis in code, comments, or docs** unless a user explicitly
  asks.
- **No `console.log`** in production paths — use NestJS `Logger`. CI
  rejects `console.log`; `console.warn` and `console.error` are
  allowed for genuine errors only.
- **JSDoc on every public class, method, and interface.** Skip it on
  trivial private helpers only.
- **File naming**: artefacts use dot notation (`*.service.ts`,
  `*.module.ts`, `*.interceptor.ts`, ...); pure type files use
  kebab-case without a suffix (`transaction-handle.ts`,
  `isolation.ts`). See `CLAUDE.md` § "File Structure" for details.

## Dependency boundaries

Strict top-to-bottom layering:

```
cqrs → (optional) typeorm → core → NestJS platform + Node builtins
```

- `core` does NOT import TypeORM, Prisma, or any ORM.
- `core` does NOT import `@nestjs/cqrs`.
- `typeorm` does NOT import `@nestjs/cqrs`.
- Reverse dependencies are forbidden and should fail code review.

## Architectural decisions

Significant architectural choices live as ADRs under
[`docs/adr/`](docs/adr/). If your PR changes an architectural invariant
(dependency boundaries, public API stability, wrapping strategy, etc.),
add or supersede an ADR in the same PR.

Smaller trade-offs that do not warrant a full ADR go in CLAUDE.md's
"Design Decisions" section.

## Opening a PR

1. Branch from `main`. PRs target `main`.
2. Changeset committed (if user-visible change).
3. All of `lint`, `build`, `test`, `typecheck`, `format:check` clean
   locally. CI runs the same gates.
4. Description explains the **why** — reviewers can read the diff for
   the what.
5. Link related issues.

## Releases

Releases are fully automated by the `release` workflow:

1. You merge a PR to `main` with a changeset.
2. The workflow opens (or updates) a "Version Packages" PR that bumps
   versions in each package's `package.json` and writes `CHANGELOG.md`
   entries (the changelog is generated with
   [`@changesets/changelog-github`](https://github.com/changesets/changesets/tree/main/packages/changelog-github),
   which links each entry back to the originating PR).
3. Merging that PR triggers the workflow again; this time it publishes
   to npm using the `NPM_TOKEN` secret.

Maintainers do not run `changeset publish` manually.

## Publishing and npm provenance

Every published tarball carries an
[npm provenance attestation](https://docs.npmjs.com/generating-provenance-statements) —
a cryptographic statement signed by npm's registry that binds the
tarball to:

- the GitHub repository and branch it was built from,
- the specific workflow run (`release.yml`), commit SHA, and
- the `npm publish` command that produced it.

### How it's wired

1. `.github/workflows/release.yml` grants `id-token: write` to the
   release job — required so GitHub Actions can issue an OIDC token
   that npm trusts.
2. Each publishable package declares `publishConfig.provenance: true`
   in its own `package.json`. npm reads this at publish time and
   records an attestation against the tarball.
3. `changesets` runs `npm publish` per package during the `release`
   step — `publishConfig.provenance` flows through to npm without any
   changesets-specific plumbing.
4. Publishing from anywhere other than the `release` workflow (a
   laptop, a different CI) will **fail** the OIDC check — provenance
   cannot be forged, and unauthenticated publishes are rejected
   because of `NPM_TOKEN`'s narrow scope.

> **Note on `changeset publish --provenance`**: as of
> `@changesets/cli@2.31`, the CLI does not accept `--provenance` as a
> flag; enabling provenance is done via either `publishConfig.provenance`
> (used here) or the `NPM_CONFIG_PROVENANCE=true` environment variable.

### Verifying a published release

```bash
# show the attestation bundle for a specific version
npm info @nestjs-transactional/core@<VERSION> --json | jq .dist.attestations

# list all published versions with provenance
npm audit signatures
```

On the npm website, versions with provenance display a green "Built
and signed on GitHub Actions" badge on the package page.

### Local dry-run

To preview what `changeset publish` would do without hitting the
registry:

```bash
# 1. check which packages have pending bumps based on .changeset/*.md
pnpm changeset status --verbose

# 2. preview per-package tarball contents (no network)
npm -C packages/core pack --dry-run
npm -C packages/typeorm pack --dry-run
npm -C packages/cqrs  pack --dry-run
```

Provenance is not generated by a local dry-run — it is minted by
npm's registry during the actual publish from GitHub Actions.
