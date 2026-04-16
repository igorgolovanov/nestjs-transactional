# ADR-004: Public API stability policy

## Status

Accepted — 2026-04-24.

## Context

The packages in this monorepo target production NestJS applications.
Once an application adopts `@Transactional()`, it has annotated
hundreds of methods with framework decorators; service code injects
adapter helpers from `@nestjs-transactional/typeorm`; aggregates
reach for `OutboxEventPublisher`; tests pull
`InMemoryTransactionAdapter` from the `/testing` subpath. A
breaking change in any of those exports forces an audit across
the consuming codebase.

We need a clear contract for what is and isn't covered by stability
guarantees, and a rule for when breaking changes are acceptable.
Without one, users can't tell which imports they can rely on,
contributors can't tell what changes need a major bump, and the
release process degenerates into ad-hoc judgement calls.

There are three reasonable shapes for such a policy:

- **No policy.** Move fast, break things, communicate via
  changelogs. Common in early-stage projects.
- **Strict semver from day one.** Every breaking change forces a
  major bump; pre-1.0 is acceptable but tracked.
- **ZeroVer.** Stay on `0.x` indefinitely; minor version is the
  effective major. Used by some Go libraries; explicit signal
  that "we don't promise stability".

## Decision

Adopt **strict [Semantic Versioning](https://semver.org/)**, with
a clearly-bounded definition of the public API surface.

### Public API surface

The **public API** of a package consists exactly of:

1. **Named exports from the package's main entry point**
   (`index.ts` → published as `import { ... } from
   '@nestjs-transactional/<name>'`).
2. **Named exports from documented subpath entry points** —
   currently `/testing` (e.g.
   `@nestjs-transactional/core/testing`,
   `@nestjs-transactional/outbox/testing`).
3. **Behaviour observable through those exports**, including:
   - Method signatures, return types, thrown error classes.
   - DI token strings produced by the `getXxxToken(dataSource)`
     helpers (Phase 14 onwards) — once shipped, the token format
     itself is API.
   - Module factory shapes (`forRoot` / `forRootAsync` /
     `forFeature` option object fields).
   - Decorator metadata key contracts where the metadata is
     read by user code.

Anything not in (1)–(3) is **internal** and not covered by
stability guarantees. Specifically internal:

- Files imported from any non-exported path
  (`@nestjs-transactional/core/dist/internal/...`,
  `@nestjs-transactional/outbox/dist/repository/...`, etc.).
  These work because TypeScript / Node module resolution allow
  it, but importing them is at the user's risk.
- Framework-private DI tokens not re-exported from the entry
  point.
- The exact text of error messages (the `code` property is
  stable; the human-readable `message` is not).
- Internal class names, method names of non-exported classes,
  prototype patches, and hook lifecycle implementation details.
- The `dist/` folder layout.

### Versioning rule

For each package:

- **Major bump (`x.0.0`)** — any breaking change to the public
  API as defined above. Includes signature changes, removed
  exports, changed default behaviour, changed token strings,
  changed migration semantics.
- **Minor bump (`0.x.0`)** — backwards-compatible additions to
  the public API. New exports, new option fields with safe
  defaults, new methods on existing classes.
- **Patch bump (`0.0.x`)** — backwards-compatible bug fixes.
  Behaviour conforms to the documented contract; no new
  surface area.

### Pre-1.0 (alpha/beta) phase

While packages remain on `0.x.y`, breaking changes are
acceptable but tracked: every breaking PR requires a
[changeset](https://github.com/changesets/changesets) entry
labelled `major`, and the breaking change is documented in
the package's release notes. The intent is that consumers
who pin to `0.x.0` can choose when to follow major bumps,
even within the pre-1.0 phase.

After `1.0.0` ships, breaking changes additionally require an
ADR documenting the rationale (or an addendum to an existing
ADR). Pre-1.0 ADRs are encouraged but not required.

### Tooling

- **Changesets** (`pnpm changeset`) is the source of truth for
  release intent. Every PR that touches public API ships a
  changeset.
- **`@arethetypeswrong/cli`** runs in CI to verify that the
  published types match the runtime exports.
- **`publint`** runs in CI to verify package.json `exports`
  field consistency.

### Process commitments

- Spec files (`*.spec.ts`) are excluded from the published
  tarball — internal implementation details should not leak
  into consumers' `node_modules`.
- Source maps and TypeScript declarations are published.
- The `@deprecated` JSDoc tag is the canonical signal that an
  export will be removed in the next major. Deprecated exports
  remain functional for at least one minor cycle; their
  removal happens at the next major bump and ships with a
  changeset entry.

## Alternatives Considered

### No formal policy

Treat each release as best-effort and document changes in the
changelog only.

Rejected because:

- Library users need to know what to depend on. Without a
  policy, every import is an open question.
- Contributor PRs have no clear standard for "is this a
  breaking change?" — every review re-litigates the rule.
- The framework targets production NestJS apps, where
  surprise breakages are expensive.

### ZeroVer

Promise nothing. Stay on `0.x` indefinitely.

Rejected because:

- The framework mission is "declarative transactions on par
  with Spring" — a production-grade goal. ZeroVer signals
  the opposite.
- We DO want to make stability commitments; we just want them
  to be precise about what they cover.
- The pre-1.0 phase already gives us flexibility to break
  things while we settle the API; we don't need to extend
  that phase indefinitely.

### Promise stability for everything that's importable

Treat any TypeScript-resolvable import as public, even
non-exported deep paths.

Rejected because:

- Effectively prohibits internal refactoring. The framework
  has many implementation details (the wrapping triad's
  internals, scanner code, the prototype patches in the
  TypeORM adapter) that need room to evolve.
- Encourages users to import from internal paths and assume
  stability. Better to draw the line crisply at the
  documented entry points.

### Public API only via runtime API; no TypeScript-level
stability

Promise that runtime behaviour is stable but allow types to
shift across minor versions.

Rejected because TypeScript types ARE the developer
experience. Type drift breaks builds, cascades through
generic instantiation, and hits library consumers who can't
fix it without bumping our package. Types and runtime are
both public.

## Consequences

### Positive

- **Predictable upgrades for users.** Pinning to
  `^0.5.0` (or post-1.0 `^1.2.0`) gives a documented
  guarantee about what won't change.
- **Clear standard for contributor PRs.** "Is this a
  breaking change?" has a definitive answer keyed on what's
  exported.
- **Internal refactoring stays cheap.** Anything not exported
  is fair game for redesign; the public surface stays small
  and stable.
- **Tooling enforces the policy.** Changesets in CI, types
  validation, package.json validation — humans don't have to
  remember.

### Negative

- **Discipline tax on contributors.** Every public-facing PR
  needs a changeset and (post-1.0) an ADR for breaking
  changes. The cost is real but bounded: a paragraph of
  prose per non-trivial PR.
- **Pre-1.0 churn confuses some users.** Until 1.0 ships,
  consumers who don't read changelogs can be surprised by
  major bumps. Mitigation: README of each package lists the
  current stability tier (alpha / beta / stable).
- **Token formats are part of the API** (Phase 14 token
  utilities — [DD-020](../dd/020-multi-adapter-datasource-name.md)).
  Changing
  `getTransactionManagerToken('billing')` from one string
  format to another is itself a breaking change. We accepted
  this when shipping the token utilities; it's documented in
  ADR-018.

### Mitigations

- The framework deliberately re-exports a small set of
  *carefully-chosen* symbols from each package. We don't
  re-export internal helpers, even when they're convenient,
  because every export is a future obligation.
- Pre-1.0 packages are explicitly labelled as alpha/beta in
  the README so consumers know to expect breaking changes
  during this phase.
- The `/testing` subpath isolates testing utilities from
  the main entry point — testing utilities can evolve
  without bleeding into production-facing exports.

## Notes

- This ADR is process-level rather than architectural. It
  predates the actual 1.0 release (still pending) but the
  policy is in effect from the first published release.
- The `@arethetypeswrong/cli` and `publint` checks were
  added in Phase 4 (CI/CD setup) and are non-negotiable
  parts of the release process.
- Future ADRs that introduce or change public API surface
  (ADR-018 token utilities, ADR-014 handler API redesign,
  any future ADR-NNN) cite this one for the stability
  contract that PRs implementing them must follow.
