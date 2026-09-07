# ADR-022: ESM-only packaging, and the 2.0.0 that comes with it

- **Status**: Accepted
- **Date**: 2026-09-07
- **Related**:
  - ADR-004 (public API stability: a breaking change needs a major and an ADR)
  - ADR-018 (multi-adapter architecture)
  - DD-017 (reuse of `ClientsModule`, hence of whatever `@nestjs/microservices` ships)

## Context

`@nestjs/typeorm` 12 arrived as a Dependabot bump and failed the build
with `TS1479`: a CommonJS file cannot `require()` an ECMAScript module.
Reading the registry rather than the error message showed the shape of
the thing:

| Package (12.x) | `type` | `exports` |
| --- | --- | --- |
| `@nestjs/common` | `module` | bare paths, no conditions |
| `@nestjs/core` | `module` | bare paths, no conditions |
| `@nestjs/microservices` | `module` | bare paths, no conditions |
| `@nestjs/testing` | `module` | bare paths, no conditions |
| `@nestjs/platform-express` | `module` | bare paths, no conditions |
| `@nestjs/typeorm` | `module` | `import` / `default` only, no `require` |
| `@nestjs/cqrs` | `module` | has a `require` condition, pointing at the same ESM file |

The whole NestJS 12 line is ESM-only, with one build and no CommonJS
output. `@nestjs/cqrs`' `require` condition is cosmetic: there is no
second bundle behind it.

CommonJS consumers are nonetheless not locked out, because Node's
`require(esm)` loads a synchronous ESM graph from CommonJS. That is not
inference: from a CommonJS script we successfully `require()`d
`@nestjs/common` 12, `@nestjs/core` 12, `@nestjs/testing` 12 and
`@nestjs/typeorm` 12, and loaded our own CommonJS `dist` alongside them.
`@nestjs/typeorm` 12 declaring `engines.node >= 20.19.0` is the giveaway:
that is precisely the release where `require(esm)` was backported, and
Nest is relying on it instead of shipping dual builds.

Two consequences followed for this repository.

First, supporting NestJS 12 turned out **not** to require migrating.
Switching `module` / `moduleResolution` from `Node16` to `NodeNext` was
enough for five of the six packages to build and typecheck against
NestJS 12 with no source change at all. `Node16` models the older
semantics in which `require(esm)` does not exist; `NodeNext` does not.

Second, `@nestjs/cqrs` 12 did make one real API change, in the exact
seam our `cqrs` package overrides: `EventPublisher`'s two merge methods
moved their constraint from the concrete `AggregateRoot` class to the
`IAggregateRoot` interface. An override cannot be narrower than the base
it overrides, so `TransactionalEventPublisherAdapter` stopped compiling.
The `asyncContext` parameter those signatures carry is **not** new in
12; it was already there in 11, and our adapter has been dropping it on
both.

## Decision

**Publish ESM only, from `2.0.0`, with `engines.node >= 22.12.0`.**

1. **One build, not two.** Dual CommonJS + ESM would avoid the major,
   and it is the wrong trade here specifically. This framework keys DI
   on class identity: `getDataSourceToken()` returns the `DataSource`
   class itself as the token, and the adapter registry, the outbox
   registries and the CQRS publisher all rely on a single instance of a
   given class per process. Two copies of our code in one process is the
   dual package hazard, and it is the same failure mode as the pnpm
   peer-in-identity problem this repository has already been bitten by:
   silent at install, surfacing much later as an unresolvable provider.
   One build cannot produce it.

2. **One Node floor across the cohort: `>=22.13.0`.** `require(esm)`
   landed in 22.12.0 on the 22 line, so the four packages sitting at
   `22.11.0` were declaring a floor that would not work for a CommonJS
   consumer. The obvious correction is 22.12.0, and it was rejected:
   `typeorm` and `outbox-typeorm` were already at `22.13.0` because
   TypeORM 1.x requires it, and the README badge, `.nvmrc` and
   CONTRIBUTING have all said 22.13 for some time. A 22.12 / 22.13 split
   would make readers reason about one patch release for no gain, so the
   floor already on the tin wins and every package now states it.

3. **CommonJS consumers keep working**, through `require(esm)`, and this
   is verified rather than asserted: before they were converted, all 19
   example applications built as CommonJS against the ESM packages.

4. **`attw` runs with `--profile esm-only`.** It reports
   `CJSResolvesToESM` under its default profile, which is correct for
   the `node16` resolution mode it models and wrong for the floor we
   declare. The profile states the intent instead of silencing a rule.

5. **Peer ranges widen to include `^12.0.0`** for `@nestjs/common`,
   `@nestjs/core`, `@nestjs/typeorm`, `@nestjs/microservices` and
   `@nestjs/cqrs`.

6. **`TransactionalEventPublisherAdapter` is typed structurally** so it
   satisfies both majors' base signatures, and it now declares the
   `asyncContext` parameter it had been silently omitting.

## What `asyncContext` does and does not do here

The adapter accepts `asyncContext` and does not use it, on both majors,
and that is deliberate rather than an oversight left in place.

The base `EventPublisher` forwards it to
`eventBus.publish(event, this, asyncContext)`, where it selects a
request-scoped handler instance. This adapter never reaches that path:
`TransactionalEventDispatcher` keeps its own listener registry and binds
each handler method to its instance at registration time, so there is no
scoped resolution left for an `AsyncContext` to influence. Forwarding it
into our own strategy would move a value nobody reads.

Scoped CQRS handlers are therefore not supported through this publisher.
That was already true before this ADR; what changes is that it is now
written down and visible in the signature.

## Consequences

### Positive

- The packages track the ecosystem instead of pinning behind it. NestJS
  12 is supported, and so is the ESM-only direction the rest of the
  Nest packages have taken.
- No dual package hazard, on a codebase where class identity is load
  bearing.
- One build to test, one to verify with `publint` and `attw`, one set of
  paths in stack traces.
- The migration surfaced two latent defects that had nothing to do with
  ESM: the dropped `asyncContext`, and a `.tsbuildinfo` cache that made
  the example builds fail against source that was already correct.

### Negative

- `2.0.0` is a breaking change for anyone below Node 22.12, and for any
  toolchain with its own module loader that does not implement
  `require(esm)`. Jest is exactly that case, which is why the suites in
  this repository now run with `--experimental-vm-modules`.
- Consumers on CommonJS keep working but inherit that same constraint in
  their own test setups. The recipe is in CONTRIBUTING and in the
  example applications, all 19 of which run their suites this way.
- `jest.mock` does not exist under ESM. One spec needed
  `jest.unstable_mockModule` plus dynamic imports, and `@jest/globals`
  types mocks more strictly than the ambient `@types/jest` did, which
  cost a pass over roughly forty mock declarations.

## Alternatives considered

- **Dual CommonJS + ESM, staying on 1.x.** Rejected on the dual package
  hazard above. The version cost is real but a wrong-instance DI failure
  in a user's process is worse, and it would be ours to explain.

- **Stay CommonJS and pin `@nestjs/*` below 12.** Rejected: it is a
  standstill, not a decision. Nest 12 is out, the whole line is ESM, and
  a framework that cannot be used with the current major of the
  framework it extends has a short shelf life.

- **Switch the test runner to Vitest**, which handles ESM natively.
  Considered while Jest looked unworkable, and dropped once ts-jest in
  ESM mode passed all 706 package tests. Changing runners is a large
  change to make for a problem that turned out to be configuration.

## References

- `tsconfig.base.json` — `NodeNext`, which is what permits `require(esm)`
  in the emitted CommonJS of consumers still on it.
- `jest.config.base.js` — the three settings that make the suites run as
  ESM, and why each is load bearing.
- [ADR-004](004-public-api-stability.md) — the policy this major is
  taken under.
