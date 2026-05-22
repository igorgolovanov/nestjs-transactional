# ADR-020: Prototype-level wrapping for CQRS handlers

- **Status**: Accepted
- **Date**: 2026-05-22
- **Related**:
  - ADR-005 (method wrapping strategy — triad of mechanisms; this ADR amends the third leg)
  - DD-002 (we do not fork `@nestjs/cqrs`; we wrap, not patch)
  - DD-008 (method wrapping via a triad of mechanisms)

## Context

ADR-005 established three coordinated wrapping mechanisms for the
`@Transactional` semantics:

1. `TransactionalInterceptor` — request-boundary handlers (controllers,
   resolvers, gateways, message patterns).
2. `TransactionalMethodsBootstrap` — regular `@Injectable` services.
3. `CqrsHandlerWrapper` — `@CommandHandler` / `@QueryHandler` /
   `@EventsHandler` classes.

The third leg, [`CqrsHandlerWrapper`](../../packages/cqrs/src/handlers/handler-wrapper.ts),
performs its wrap as an own-property assignment on the handler
**instance**:

```ts
host[methodName] = wrapped;   // host is the resolved instance
```

The instance is obtained by scanning `DiscoveryService.getProviders()`
at `OnApplicationBootstrap`. This works for handlers whose dependency
tree is fully static (singleton scope) — `@nestjs/cqrs`'s bus binds the
handler once at registration, and every subsequent dispatch calls
`instance.execute(query)` as a property lookup on that same instance.
The wrap sticks.

It does not work for `Scope.REQUEST` or `Scope.TRANSIENT` handlers.
The current implementation documents this in JSDoc and in the package
README ("Only works with singleton handlers"), and
[`TransactionalMethodsBootstrap`](../../packages/core/src/bootstrap/transactional-methods.bootstrap.ts)
explicitly skips CQRS handler classes via metadata-key sniffing,
deferring wrapping to `CqrsHandlerWrapper`. So a `Scope.REQUEST` query
handler ends up unwrapped by all three mechanisms.

Two root causes:

- For non-singleton providers, `DiscoveryService` exposes the provider
  wrapper but `wrapper.instance` is `null` at bootstrap (the instance is
  created lazily per `ModuleRef.resolve`). The wrap loop has no instance
  to mutate.
- Even if an instance were available, `@nestjs/cqrs` dispatches each
  non-singleton handler via a fresh `ModuleRef.resolve(metatype,
  context.id, {strict:false})` ([`query-bus.js:81-88`](../../node_modules/.pnpm/@nestjs+cqrs@11.0.3_@nestjs+common@11.1.19_reflect-metadata@0.2.2_rxjs@7.8.2__@nestjs+core@11_ofzkycwadycmtosxe2ee7gne2q/node_modules/@nestjs/cqrs/dist/query-bus.js),
  [`command-bus.js:81-89`](../../node_modules/.pnpm/@nestjs+cqrs@11.0.3_@nestjs+common@11.1.19_reflect-metadata@0.2.2_rxjs@7.8.2__@nestjs+core@11_ofzkycwadycmtosxe2ee7gne2q/node_modules/@nestjs/cqrs/dist/command-bus.js)).
  Each dispatch yields a new instance on which any bootstrap-time wrap
  has not landed.

### Use case forcing the issue

Real-world: a handler injects `AsyncContext` (the class exported by
`@nestjs/cqrs`, not the Nest `REQUEST` token directly) to carry
per-request data — `userId`, geo, A/B flags, subscription, region,
organization — through a chain of dispatches in one HTTP request:

```ts
import { QueryHandler, IQueryHandler, AsyncContext } from '@nestjs/cqrs';
import { Inject, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@QueryHandler(ListCreatedIssueContributionsQuery, { scope: Scope.REQUEST })
export class ListCreatedIssueContributionsQueryHandler
  implements IQueryHandler<ListCreatedIssueContributionsQuery> {
  constructor(
    @Inject(REQUEST) private readonly context: AsyncContext,
    // ... domain dependencies
  ) {}

  async execute(query: ListCreatedIssueContributionsQuery) {
    // uses this.context.userId / .geo / .abFlags / ...
  }
}
```

`@nestjs/cqrs`'s `AsyncContext` is a handle over a `ContextId`. The bus
calls `moduleRef.registerRequestByContextId(ctx, ctx.id)` so the
standard `REQUEST` injection token resolves to the `AsyncContext`
inside every request-scoped provider attached to that `contextId`. A
single `AsyncContext` shared between N dispatches in the same HTTP
request — via `AsyncContext.merge(parentSource, query)` or
`ctx.attachTo(query)` — yields **one** request-scoped handler instance
reused across all N dispatches.

Both `Scope.REQUEST` (one instance per request, shared via attached
`AsyncContext`) and `Scope.TRANSIENT` (a fresh instance per dispatch)
are valid `@nestjs/cqrs` patterns. Neither is currently transactional
under our library.

### Key technical observation

In `@nestjs/cqrs` 11.x, `QueryBus.bind` and `CommandBus.bind` end
their non-static branch with:

```js
const instance = await this.moduleRef.resolve(handler.metatype, context.id, { strict: false });
return instance.execute(query);   // property lookup, late binding
```

`instance.execute` is resolved through the prototype chain at call
time. If the prototype of `handler.metatype` carries our wrapped
method, every dispatch — singleton, request-scoped, transient — picks
it up. `this` inside the wrapper points to the concrete (possibly
request-scoped) instance, where `@Inject(REQUEST) AsyncContext` is
populated. `TransactionManager` is closed over from the wrap site as a
singleton, which it is anyway.

This is the lever the present ADR pulls on.

## Decision

Move `CqrsHandlerWrapper`'s wrap target from the **instance** to the
**class prototype**. One path, unconditional. No feature flag.

### 1. Iterate metatypes, not instances

The wrap loop continues to use `DiscoveryService.getProviders()` —
NestJS's discovery service exposes the provider wrapper for every
registered provider regardless of scope, and the wrapper's `metatype`
property is populated even when `instance` is `null`. The loop
classifies CQRS handler classes via the existing metadata-key check
(`__commandHandler__` / `__queryHandler__` / `__eventsHandler__`) and
proceeds from `metatype` alone.

### 2. Wrap the prototype method, not the instance method

```ts
const proto = (metatype as Function).prototype as Record<string, unknown>;
const protoMethod = proto[methodName];
if (typeof protoMethod !== 'function') continue;
if (Reflect.getMetadata(WRAPPED_MARKER, protoMethod) === true) continue;

const resolved = this.resolveMetadata(protoMethod, metatype, kind);
if (resolved === undefined) continue;

const original = protoMethod as HandlerMethod;
const manager = this.manager;

const wrapped = function (this: object, ...args: unknown[]): Promise<unknown> {
  return manager.run(resolved, () => Promise.resolve(original.apply(this, args)));
};

Reflect.defineMetadata(WRAPPED_MARKER, true, wrapped);
Reflect.defineMetadata(TRANSACTIONAL_METADATA, resolved, wrapped);
proto[methodName] = wrapped;
```

The wrapper is a regular `function`, not an arrow — `this` is bound by
the call site (`instance.execute(query)`). `original.apply(this, args)`
preserves the caller's `this` so the handler's own state, including
its injected `AsyncContext`, is available.

### 3. WRAPPED_MARKER on the prototype method

The same `Symbol.for('@nestjs-transactional/wrapped')` marker carries
over from the instance-level implementation. Double-wrap protection is
unchanged. The marker now lives on the prototype function rather than
on a per-instance function — the semantics are the same (one marker
per wrapped method).

### 4. Scope of this ADR

Only the third leg of ADR-005's triad moves. The interceptor (leg 1)
and the regular `@Injectable` bootstrap (leg 2) keep their current
shapes:

- `TransactionalInterceptor` operates on the NestJS request pipeline,
  not on providers — no analogous change applies.
- `TransactionalMethodsBootstrap` already iterates the prototype via
  `MetadataScanner.getAllMethodNames(prototype)`, then assigns to the
  instance. Moving its assignment to the prototype is a possible
  future amendment but is out of scope here. The set of users who run
  request-scoped or transient regular `@Injectable` services AND want
  `@Transactional` on them is narrower than the CQRS case, and there
  is no current concrete need.

The triad description in ADR-005 stays valid; the implementation
detail of leg 3 changes.

## Alternatives considered

### Hybrid: prototype + instance fallback for arrow-property `execute`

Where a handler defines `execute` as an arrow assigned to an instance
property (`execute = async (q) => {...}`) the method does not live on
the prototype, so a prototype wrap finds nothing and the instance
wrap would still be needed.

Rejected. Arrow-as-`execute`/`handle` is not a pattern that appears in
`@nestjs/cqrs` ecosystem code or in the consuming project that
prompted this ADR. Documenting it as unsupported is cheaper than
carrying a branch with two code paths. If a real-world need emerges,
the fallback is mechanically additive (`if protoMethod === undefined →
look at known instances via DiscoveryService`) and a follow-up ADR
revision is small.

### Configuration option `wrapStrategy: 'instance' | 'prototype'`

Rejected. ADR-005 frames the wrapping mechanism as "one strategy per
mechanism"; introducing a runtime knob fragments the mental model and
the test matrix. The decision should be made once, in code.

### Reuse `@nestjs/cqrs`'s `ExplorerService` to list handler classes

Rejected. DD-002 keeps the library at arm's length from `@nestjs/cqrs`
internals beyond the documented metadata keys we already read. The
`DiscoveryService` route reuses NestJS's stable provider discovery
API; an additional dependency on `ExplorerService` adds coupling
without buying anything `DiscoveryService` cannot already give us.

### Push the architectural cost onto the user (AsyncLocalStorage-based context, no `Scope.REQUEST`)

A valid user-side pattern — replace `@Inject(REQUEST) AsyncContext`
with an `AsyncLocalStorage`-backed singleton context service, opened
at the HTTP request boundary by middleware — would let handlers stay
singleton and the existing wrap would Just Work. The library would
need no changes.

Rejected as the framework-side answer. `@nestjs/cqrs`'s `AsyncContext`
is the native, documented mechanism for the exact problem this user
case raises (per-request data carried through a dispatch chain). A
transactional library that requires users to abandon a native CQRS
mechanism to get transactions is failing at integration, not at
correctness. The user-side pattern remains a legitimate choice (and is
worth documenting), but it should not be the only choice.

### Prototype patching inside `@Transactional()` decorator

Equivalent to ADR-005's rejected option "prototype wrapping inside the
decorator" — same reason still applies: no DI access, no
`TransactionManager`. The wrap must happen at bootstrap when the
container is built, regardless of whether the wrap site is the
instance or the prototype.

## Consequences

### Positive

- **Request-scoped and transient CQRS handlers gain transactional
  semantics**. The documented "only works with singleton handlers"
  limitation is lifted. The native `@nestjs/cqrs` `AsyncContext`
  pattern composes with `@Transactional`.

  Caveat for `Scope.TRANSIENT`: `@nestjs/cqrs` 11.x routes a
  `Scope.TRANSIENT` handler through the `isDependencyTreeStatic ===
  true` branch of `bind` when the handler has no request-scoped
  dependency. Constructor is not invoked per dispatch in that path;
  `instance.execute(query)` is called against a prototype-backed
  reference. Our prototype wrap still applies (the wrap point is the
  prototype itself), and `manager.run` opens a transaction per call,
  so `@Transactional` semantics hold. Per-dispatch instance identity
  is a `@nestjs/cqrs` choice independent of this ADR. A `TRANSIENT`
  handler that DOES inject a request-scoped dependency falls into
  the non-static branch and gets a fresh instance per dispatch — the
  wrap continues to apply through the prototype.
- **Independent of bootstrap-time instance availability**. The wrap
  no longer relies on `DiscoveryService` returning a populated
  `wrapper.instance` for CQRS handlers — `wrapper.metatype` alone is
  enough. Less coupling to NestJS lifecycle timing.
- **Same single source of truth**. One wrap per class instead of one
  wrap per instance; the marker semantics simplify by analogy.
- **No public API change**. Existing code, examples, and docs continue
  to work. Singleton CQRS handlers behave identically (late lookup
  through the prototype was already what `@nestjs/cqrs` did
  internally; the wrap is now where the lookup ended up looking).

### Negative

- **Arrow-property `execute`/`handle` is no longer wrapped**. A
  handler defining `execute` as an instance arrow property shadows
  the prototype, and the prototype wrap will not be invoked. This
  pattern is uncommon in `@nestjs/cqrs` code; the library documents
  it as unsupported in the README "Limitations" section and in the
  class JSDoc.
- **Prototype mutation is global per class**. A consumer who subclasses
  a CQRS handler will inherit the wrapped prototype method via the
  prototype chain. This matches `@nestjs/cqrs`'s own behaviour
  (handlers are typically not subclassed) and is no worse than the
  instance-level wrap, which would have wrapped each subclass
  instance independently. No known practical impact.
- **Test isolation requires explicit reset**. Prototype mutation
  persists across `TestingModule` rebuilds — `WRAPPED_MARKER` makes
  subsequent `wrapAll` calls idempotent no-ops, but the obsolete
  wrapper from the previous test stays on the prototype. Existing
  test suites that rebuild the module per `it` and rely on
  "wrapped vs. unwrapped" assertions need a reset between cases.
  Mitigation: `CqrsHandlerWrapper.resetForTesting()` static method
  (mirrors `OutboxModule.resetForTesting` from ADR-019 § 5) — clears
  the tracker and restores the original prototype methods. Called
  from `beforeEach`. Documented `@internal`; production code calling
  it after the wrap loop has run does not affect already-resolved
  handler instances.
- **Ordering with `@nestjs/cqrs` `bind`**. The wrap runs at
  `OnApplicationBootstrap`, after `@nestjs/cqrs`'s `ExplorerService`
  has called `bus.bind(handler, ...)` in its own
  `onModuleInit`. The prototype mutation lands before the first
  dispatch (which only happens once the HTTP request pipeline is
  open). If a future `@nestjs/cqrs` major changes `bind` from a
  late-lookup closure to an early-bound reference
  (`const bound = instance.execute.bind(instance); set(handler, ...)`),
  the prototype wrap would stop applying retroactively. Mitigation:
  the cqrs peer-dependency range pins major; tests cover the
  late-lookup behaviour explicitly; CI fails before a broken upgrade
  ships.

### Neutral

- **ADR-005 stays valid**. The triad of mechanisms is unchanged; only
  the implementation detail of the third leg shifts. ADR-020 amends
  ADR-005 § "CqrsHandlerWrapper" without superseding it.
- **Documentation surface**. The "Only works with singleton handlers"
  bullet leaves the README and JSDoc. The README gains a positive
  statement: "Works with `Scope.DEFAULT`, `Scope.REQUEST`, and
  `Scope.TRANSIENT` handlers". The arrow-property note moves into the
  Limitations section.
- **Test surface grows by three integration specs** (default /
  request / transient) plus a refactored unit spec. No examples need
  to change.

## Implementation reference

Epicentre: [`packages/cqrs/src/handlers/handler-wrapper.ts`](../../packages/cqrs/src/handlers/handler-wrapper.ts)
— the `wrapHandler` / wrap-loop methods. The classifier
(`classifyHandler`), metadata resolution (`resolveMetadata`),
kind-specific defaults (`pickDefaults`), and the logger surface are
unchanged.

Tests to add under
[`packages/cqrs/test/integration/`](../../packages/cqrs/test/integration/):

- `scope-default.integration.spec.ts` — singleton regression: a
  command + a query handler with no explicit scope, both wrapped, both
  observe the active transaction; `defaultQueryOptions: { readOnly:
  true }` still applies.
- `scope-request.integration.spec.ts` — request-scoped query handler
  injecting `AsyncContext`. Two dispatches in one HTTP request share
  one `AsyncContext` via `AsyncContext.merge(query, ctx)` → one
  handler instance reused, both calls transactional, context populated
  inside both.
- `scope-transient.integration.spec.ts` — transient command handler.
  Two dispatches yield two distinct instances; both wrapped, both
  transactional.

Unit additions to [`packages/cqrs/src/handlers/handler-wrapper.spec.ts`](../../packages/cqrs/src/handlers/handler-wrapper.spec.ts):

- Prototype is mutated (own property on the prototype object).
- `WRAPPED_MARKER` is set on the prototype method.
- Double-wrap is a no-op (marker check short-circuits).
- A subclass inherits the wrapped method via the prototype chain.
- `CqrsHandlerWrapper.resetForTesting()` restores the original
  prototype method and clears the marker.

Test-isolation API:

- `CqrsHandlerWrapper.resetForTesting()` — `@internal` static. Tracks
  every prototype it has mutated (`Map<metatype,
  { methodName, originalMethod }>`). On call, restores each tracked
  prototype method and clears the tracker. Naming and shape mirror
  `OutboxModule.resetForTesting` (ADR-019 § 5).
- `CqrsHandlerWrapper` implements `OnModuleDestroy` and calls
  `resetForTesting()` from the lifecycle hook. This restores
  prototypes automatically on `module.close()` (the conventional
  `afterEach` teardown), so existing spec files that rebuild the
  `TestingModule` per `it` do not need an explicit `beforeEach`
  reset to stay green. The explicit static remains for tests that
  skip `module.close()` or need an inline reset between assertions
  inside a single `it`. Production effect of the hook is none: by
  the time it fires the app is shutting down and no further bus
  dispatches happen.

Docs to update:

- [`packages/cqrs/README.md`](../../packages/cqrs/README.md) —
  "Limitations" section: remove the "Only works with singleton
  handlers" bullet, add the arrow-property edge case.
- JSDoc on `CqrsHandlerWrapper` — rewrite the "Limitation" paragraph
  accordingly.
- [`docs/status/conventions.md`](../status/conventions.md) — add a
  convention entry once practice surfaces patterns worth capturing
  (e.g. "share `AsyncContext` between dispatches via `merge` to keep
  one handler instance").

A changeset is added (minor, removes a documented limitation).

## Revision history

Phase-anchored. Filled after the ADR is accepted and the
implementation lands.
