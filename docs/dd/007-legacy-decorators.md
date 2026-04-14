# DD-007: Legacy decorators + reflect-metadata

**Context**: the entire NestJS ecosystem (core, TypeORM, @nestjs/cqrs)
runs on legacy decorators with the `reflect-metadata` polyfill. TC39
stage-3 decorators are incompatible: there are no parameter decorators
(critical for `@Inject`), different metadata rules, and a different
decorator return type.

**Alternatives**:
- TC39 stage-3 decorators (TypeScript 5.0+) — incompatible with NestJS
- Runtime DI only, no decorators — changes the entire API and loses the
  NestJS integration patterns

**Choice**: `experimentalDecorators: true`, `emitDecoratorMetadata: true`,
peer dependency `reflect-metadata ^0.1.13 || ^0.2.0`.

**Consequences**: compatibility with NestJS 10 and 11. If NestJS migrates
to stage-3 (not expected in the next 1–2 years) we will follow, but that
is a breaking change for the entire ecosystem.
