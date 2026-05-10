# Contributing to @nestjs-transactional

Thanks for your interest. This document captures the conventions used
across the monorepo. If any of it is out of date, please open an issue
or a PR — stale instructions are worse than none.

## Development environment

Requirements:

- **Node.js 22.11+**. CI verifies the matrix [22, 24, 26].
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

### TypeScript

- **strict mode** is mandatory: `"strict": true` in tsconfig
- **No implicit any**: all types are explicit
- **Readonly where possible**: parameters and properties are
  `readonly` when they are not reassigned
- **No enum for string literals unless needed**: union types for
  simple constants (exception: `PropagationMode` — IDE
  auto-completion matters)
- **Never use `any`** without `@ts-expect-error` and a comment;
  prefer `unknown` plus type narrowing.
  `@typescript-eslint/no-explicit-any` is `error` on non-test
  code.
- **No emojis in code, comments, or docs** unless a user
  explicitly asks.
- **No `console.log`** in production paths — use NestJS
  `Logger`. CI rejects `console.log`; `console.warn` and
  `console.error` are allowed for genuine errors only.

### Naming

- **Classes**: PascalCase (`TransactionManager`)
- **Interfaces**: PascalCase without an `I` prefix
  (`TransactionAdapter`, not `ITransactionAdapter`).
  Exception: handler interfaces consumed by user code keep the
  `I*` prefix to mark them as implement-this contracts
  (`ITransactionalEventHandler`, `IOutboxEventHandler`,
  `IIntegrationEventHandler`).
- **Types**: PascalCase (`IsolationLevel`)
- **Enum members**: SCREAMING_SNAKE_CASE
  (`PropagationMode.REQUIRES_NEW`)
- **Functions / methods**: camelCase (`runInTransaction`)
- **Constants**: SCREAMING_SNAKE_CASE (`ADAPTER_REGISTRY`)
- **DI tokens**: SCREAMING_SNAKE_CASE with `Symbol`
  (`ADAPTER_REGISTRY`, `TRANSACTION_OBSERVERS`)

### File structure

One file = one primary public entity (class / interface /
function). Helper types live in the same file if only used there,
otherwise in a separate file.

File names follow NestJS-style dot notation:
`<name>.<artifact-suffix>.ts`, where the suffix names the kind of
artifact (`service`, `controller`, `module`, `interceptor`,
`context`, `manager`, `registry`, `adapter`, `publisher`,
`dispatcher`, `wrapper`, `bootstrap`, ...). The `<name>` part is
kebab-case if multi-word (e.g. `cqrs-handler.wrapper.ts`).

Spec files mirror the source file name with a `.spec.ts` suffix;
integration specs use `.integration.spec.ts`.

```
src/
├── manager/
│   ├── transaction.manager.ts         # class TransactionManager
│   ├── transaction.manager.spec.ts    # tests (colocated)
│   ├── adapter.registry.ts            # class AdapterRegistry
│   └── adapter.registry.spec.ts
```

Pure type / interface files are an exception: no suffix,
kebab-case allowed when the filename describes the type it
exports (e.g. `transaction-handle.ts`, `isolation.ts`,
`propagation.ts`).

### Errors

- **All errors inherit from `TransactionError`** (the package's
  base) — never `throw new Error(...)`.
- **Every error has a `readonly code: string`** for structured
  logging.
- **Messages**: explicit, actionable, and carry context.

```typescript
export class TransactionAdapterNotFoundError extends TransactionError {
  readonly code = 'TRANSACTION_ADAPTER_NOT_FOUND';

  constructor(adapterName: string, instanceName: string) {
    super(
      `Transaction adapter not found: ${adapterName}:${instanceName}. ` +
      `Did you register it via TypeOrmTransactionalModule.forFeature()?`
    );
  }
}
```

### Documentation

- **JSDoc on all public APIs** (classes, methods, interfaces).
- `@param`, `@returns`, `@throws` where applicable.
- `@example` for non-trivial APIs.
- Internal entities: JSDoc optional, encouraged for complex logic.
- **Language**: all committed text (ADRs, READMEs, JSDoc,
  inline comments, commit messages) is English.

## Dependency boundaries

Strict top-to-bottom layering:

```
cqrs → (optional) typeorm → core → NestJS platform + Node builtins
```

- `core` does NOT import TypeORM, Prisma, or any ORM.
- `core` does NOT import `@nestjs/cqrs`.
- `typeorm` does NOT import `@nestjs/cqrs`.
- Reverse dependencies are forbidden and should fail code review.

## Testing strategy

### Per-package targets

- **core** — unit tests with `InMemoryTransactionAdapter` for
  TransactionContext, TransactionManager, AdapterRegistry,
  decorators, interceptor. Coverage target: 90% lines, 85%
  branches on public API.
- **typeorm** — unit tests against SQLite in-memory; integration
  tests with testcontainers (real Postgres) for savepoint
  behavior, isolation levels, multi-DataSource scenarios,
  connection pool behavior. Coverage target: 85% lines on units.
- **cqrs** — unit tests for decorators, scanner, wrapper with a
  mocked TransactionManager. Integration tests with a full NestJS
  testing module: real `CqrsModule` + `InMemoryTransactionAdapter`
  (or TypeORM SQLite). E2E tests for cross-package interaction
  (cqrs + typeorm + core). Coverage target: 85% on handler logic.
- **outbox** — coverage target 90% lines, 85% branches.
- **outbox-typeorm** — coverage target 85% lines (the remainder
  is TypeORM integration that is hard to cover in unit tests).
- **outbox-microservices** — coverage target 90% lines on units
  (ClientProxy mocked).

### Test utilities

The core package exports utilities via the `/testing` subpath:

```typescript
import { InMemoryTransactionAdapter } from '@nestjs-transactional/core/testing';
```

The outbox package exports `PublishedEvents`,
`AssertablePublishedEvents`, and `InMemoryEventPublicationRepository`
via its `/testing` subpath. The cqrs package may expose
`TransactionalTestingModule` similarly.

### When to use testcontainers

Use `testcontainers-node` for a real Postgres specifically when
testing the `outbox-typeorm` package, the TypeORM adapter's
savepoint/isolation behaviour, and example end-to-end flows. For
general application testing (even with the outbox enabled) the
in-memory repository is sufficient.

## Architectural decisions

Significant architectural choices live as ADRs under
[`docs/adr/`](docs/adr/). If your PR changes an architectural
invariant (dependency boundaries, public API stability, wrapping
strategy, etc.), add or supersede an ADR in the same PR.

Smaller trade-offs that do not warrant a full ADR go in
[`docs/dd/`](docs/dd/) as Design Decisions.

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
