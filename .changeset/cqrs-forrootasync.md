---
'@nestjs-transactional/cqrs': minor
---

`CqrsTransactionalModule.forRootAsync` for config that only exists at
runtime, plus a documented rationale for the `@nestjs/cqrs` peer range.

Core and typeorm already had `forRootAsync`; cqrs did not, which made it
the one module you could not configure from a `ConfigService`. It now
mirrors the shape the other two use — structural flags on the options
object, value-shaped config from the factory:

```ts
CqrsTransactionalModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    wrapQueryHandlers: cfg.get('WRAP_QUERIES') !== 'false',
    defaultCommandOptions: { isolation: cfg.get('TX_ISOLATION') },
  }),
});
```

`useTransactionalEventPublisher` stays on the options object rather than
the factory result: it decides whether the `EventPublisher` override
provider is registered at all, and NestJS needs provider tokens at
module-definition time, before any async factory has run. That is the
same split `OutboxModule.forRootAsync` uses for `repository`.

Both paths share one defaults resolver and one provider-matrix builder,
so they cannot drift apart — a spec asserts the two produce identical
exports and provider counts. The `exports: exportTokens as never[]` cast
on the returned module is gone, replaced by a typed `InjectionToken[]`.

Also documented, not changed: the `@nestjs/cqrs: ^11.0.0` peer stays
narrower than the `^10 || ^11` used elsewhere in this monorepo, and the
reason is now in the package README. The handler-wrapping mechanism
itself would work on `@nestjs/cqrs@10` — the metadata constants it reads
are identical across both majors — but `AsyncContext` is a v11 addition
and it is what makes the documented request-scoped handler support work.
`@nestjs/cqrs@10` also peers on `@nestjs/common ^9 || ^10`, so anyone
pinned to it is on NestJS 10 anyway.
