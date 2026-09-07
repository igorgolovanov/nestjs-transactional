---
'@nestjs-transactional/core': major
'@nestjs-transactional/typeorm': major
'@nestjs-transactional/cqrs': major
'@nestjs-transactional/outbox': major
'@nestjs-transactional/outbox-typeorm': major
'@nestjs-transactional/outbox-microservices': major
---

ESM-only packaging, and support for NestJS 12

All six packages now ship ESM and nothing else. The NestJS 12 line is
ESM-only across `@nestjs/common`, `@nestjs/core`, `@nestjs/microservices`,
`@nestjs/cqrs`, `@nestjs/testing` and `@nestjs/typeorm`, with one build
and no CommonJS output, so this follows the framework these packages
extend.

**If your application is CommonJS, it keeps working.** Node's
`require(esm)` loads these packages from CommonJS, which is the same
mechanism NestJS 12 relies on. What you need is the Node floor below.

### Breaking

- **`engines.node` is now `>=22.13.0` on every package.** `core`,
  `cqrs`, `outbox` and `outbox-microservices` were at `>=22.11.0`;
  `require(esm)` landed in 22.12.0 on the 22 line, so that floor would
  not have worked for a CommonJS consumer. They move to `22.13.0`
  rather than `22.12.0` to match `typeorm` and `outbox-typeorm`, which
  TypeORM 1.x already held there, and to match the floor the README and
  CONTRIBUTING have been stating all along.
- **The packages are `"type": "module"`.** Deep imports into
  `dist/…` were never supported and are now also physically ESM.
- **Jest needs ESM mode to run against these packages.** Its module
  registry does not use Node's `require(esm)`, so a suite that imports
  them needs `NODE_OPTIONS=--experimental-vm-modules`,
  `extensionsToTreatAsEsm: ['.ts']`, a `moduleNameMapper` mapping the
  `.js` in relative specifiers back to `.ts`, and `useESM: true` on the
  ts-jest transform. All 19 example applications in the repository show
  the working configuration.
- **`AggregateConstructor` (`@nestjs-transactional/cqrs`) is now
  constrained to `object`** rather than to `AggregateRoot`. This is a
  widening: existing usages keep compiling.

### Added

- **NestJS 12 support.** Peer ranges now accept `^12.0.0` for
  `@nestjs/common`, `@nestjs/core`, `@nestjs/typeorm`,
  `@nestjs/microservices` and `@nestjs/cqrs`, alongside the ranges that
  were there before.

### Fixed

- **`TransactionalEventPublisherAdapter` declares the `asyncContext`
  parameter** its base class has always passed. It still does not use
  it, and the JSDoc now says so and why: the dispatcher binds handler
  methods to their instances at registration, so no scoped resolution
  is left for an `AsyncContext` to influence. Scoped CQRS handlers are
  not supported through this publisher — that was already true and was
  invisible.

Reasoning, measurements and the alternatives weighed: ADR-022.
