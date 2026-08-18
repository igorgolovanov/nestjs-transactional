---
'@nestjs-transactional/cqrs': minor
'@nestjs-transactional/outbox': minor
'@nestjs-transactional/core': patch
'@nestjs-transactional/typeorm': patch
'@nestjs-transactional/outbox-typeorm': patch
'@nestjs-transactional/outbox-microservices': patch
---

Rewrites every package README, and exports three types that public
signatures already referenced.

**Three types are now importable.** Each appeared in a public signature
without being exported, so a consumer could call the method but not name
its types — found by `api-extractor`'s `ae-forgotten-export` once the
API surface reports landed:

- `CqrsTransactionalAsyncOptions` and `CqrsTransactionalAsyncFactoryResult`
  — the options type of `CqrsTransactionalModule.forRootAsync`.
- `AggregateConstructor` — the constraint on `mergeClassContext`'s type
  parameter.
- `RegistrarListenerEntry` — the parameter type of
  `MultiDsOutboxListenerRegistrar.register`.

**The READMEs are rewritten, and several of them were wrong.** These are
the pages npm renders, and they had drifted:

- `core` showed `timeout: 10_000` in an options example. `timeout` is
  accepted by the type and not implemented; the README now says so and
  explains why it is deliberately not approximated.
- `outbox`'s primary wiring snippet passed `adapters: [...]` to
  `TransactionalModule.forRoot`. There is no such option — the field is
  `adapter`, singular — so the first snippet a reader copies did not
  compile.
- `typeorm` told readers to import
  `@nestjs-transactional/typeorm/test/setup-testcontainers`. Nothing
  under `test/` is published, so that import cannot resolve.
- `outbox-typeorm` documented `OutboxTypeOrmModule.forFeature` and an
  `isDefault` option, neither of which exists, described the module
  wiring as arriving "in a later iteration" two paragraphs before
  documenting it, and headed its install section "Installation (once
  published)".
- All six claimed the API "may change between 0.x releases" while
  shipping as `1.0.0-alpha.x`.
- All six linked to documentation with relative paths like
  `../../docs/adr/...` — seventy links in total, every one of them dead
  on npmjs.com, which renders a README outside the repository tree. They
  are now absolute, and `scripts/check-doc-links.sh` resolves in-repo
  GitHub URLs so they stay checked.

Beyond the corrections, each README now leads with what the package is
for and a snippet that runs, keeps the caveats that actually bite —
`readOnly` being per-dialect, the outbox's in-memory default silently
discarding everything, `ClientProxy.emit()` not reporting broker
failure, importing `CqrsModule` twice shadowing the publisher override —
and links out for the rest instead of inlining it. They are about half
their previous length.
