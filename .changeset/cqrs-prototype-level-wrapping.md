---
'@nestjs-transactional/cqrs': minor
---

Lift the singleton-handler restriction in `CqrsHandlerWrapper`.

`@CommandHandler` / `@QueryHandler` / `@EventsHandler` classes
declared with `{ scope: Scope.REQUEST }` or
`{ scope: Scope.TRANSIENT }` now compose with `@Transactional` —
including the common request-scoped pattern where the handler
injects `@nestjs/cqrs`'s `AsyncContext` via `@Inject(REQUEST)` to
carry per-request data (user, geo, A/B flags, ...).

The wrap target moved from the resolved handler **instance** to the
handler class **prototype**, intercepting `@nestjs/cqrs`'s
late-bound `instance.execute(query)` / `instance.handle(event)`
lookup regardless of how the instance is resolved. The
`@Transactional` decorator surface, propagation modes, defaults
(`defaultQueryOptions`, `defaultCommandOptions`), event-dispatcher
semantics, and the `WRAPPED_MARKER` double-wrap protection are
unchanged. Singleton handlers behave identically.

A test-isolation API ships alongside:
`CqrsHandlerWrapper.resetForTesting()` static restores wrapped
prototypes between cases. `CqrsHandlerWrapper` also implements
`OnModuleDestroy` and calls the same cleanup automatically on
`module.close()`, so existing test suites do not need a per-`it`
reset to stay green.

Rationale and full design: see [ADR-020](https://github.com/igorgolovanov/nestjs-transactional/blob/main/docs/adr/020-prototype-level-cqrs-wrapping.md).

Known edge case: handlers defined with an arrow-function instance
field (`execute = async (q) => {...}`) are not wrapped — the
method shadows the prototype. Use regular method syntax
(`async execute(q) { ... }`) so the method lives on the prototype.
