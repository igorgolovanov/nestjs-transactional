---
'@nestjs-transactional/core': patch
'@nestjs-transactional/cqrs': patch
'@nestjs-transactional/outbox': patch
'@nestjs-transactional/outbox-microservices': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/outbox-typeorm': patch
---

Every package now declares `sideEffects`, so a bundler can tree-shake
what is safe to drop and keep what is not.

The declaration is **not** uniform, because the uniform answer would
have been wrong:

- `core`, `cqrs`, `outbox` and `outbox-microservices` have no
  import-time statements at all and declare `"sideEffects": false`.
- `typeorm` calls `applyAllPatches()` at module load — that is how the
  `Repository.prototype` patches behind transparent transactional
  repositories get installed. It declares
  `["./dist/module/typeorm-transactional.module.js"]`. A blanket
  `false` here would let a bundler drop that module when a consumer
  imports only, say, `getCurrentEntityManager`, and the patches would
  never install: repositories would keep working and would silently
  stop being transactional.
- `outbox-typeorm`'s `@Entity()` decorators register into TypeORM's
  global metadata storage when the entity modules are evaluated, so it
  declares `["./dist/entity/*.js"]`.

No runtime behaviour changes. The packages are still CJS-only, so this
mostly matters to consumers who bundle (a serverless function, say) and
to the ESM dual-packaging work when it lands.
