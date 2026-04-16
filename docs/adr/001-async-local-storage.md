# ADR-001: AsyncLocalStorage as the foundation for transaction context

## Status

Accepted — 2026-04-23.

## Context

Spring's `@Transactional` works because the JVM provides `ThreadLocal`:
the current transaction is a per-thread piece of state that nested
method calls inherit automatically without passing it through every
parameter. Node.js has no equivalent — there is one event loop, and
"current call stack" is not a useful identifier when async work is
interleaved.

For a Spring-style declarative transaction API to work in NestJS, we
need a primitive that:

1. **Propagates context across `await` boundaries.** When a service
   method opens a transaction and calls an async repository, the
   repository must see the same active transaction without being
   handed it as a parameter.
2. **Survives I/O callbacks.** Database drivers schedule callbacks
   on the event loop; the transaction context must follow.
3. **Isolates concurrent requests.** Two HTTP requests handled
   concurrently must see independent transaction state — request A's
   commit must not touch request B's transaction.
4. **Stays performant under typical load.** A library this central
   to the request path can't afford double-digit-percent overhead.

Three Node.js mechanisms answer this kind of question:

- **`AsyncLocalStorage`** from the `node:async_hooks` core module.
  Stable since Node 14; uses `AsyncResource` internally; correctly
  propagates across `await`, `Promise.then`, `setTimeout`, network
  callbacks, etc.
- **`continuation-local-storage`** (cls-hooked, the npm package).
  The community's pre-`AsyncLocalStorage` answer; built on the
  older `async_hooks` API. Now deprecated by its own maintainers
  in favour of `AsyncLocalStorage`.
- **Explicit context parameter.** Every async function takes a
  `ctx: TransactionContext` as its first parameter; callers thread
  it through manually.

## Decision

Use **`AsyncLocalStorage` from `node:async_hooks`** as the
foundation. All transaction-context state — the active transaction
handle, hooks, propagation metadata, observability hooks — lives
inside a per-process `AsyncLocalStorage` instance accessed through
the static `TransactionContext` API.

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

class TransactionContext {
  private static readonly als = new AsyncLocalStorage<TransactionContextStore>();

  static run<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
    return this.als.run(makeStore(correlationId), fn);
  }

  static getStore(): TransactionContextStore | undefined {
    return this.als.getStore();
  }
}
```

`TransactionManager.run(options, fn)` enters the ALS scope on the way
in and unwinds it on the way out. Adapter helpers
(`getCurrentEntityManager`) read the active transaction off the
store without taking it as a parameter.

`@Transactional()` therefore "just works" — once a method enters the
ALS scope, every async descendant sees the same transaction without
boilerplate.

## Alternatives Considered

### `continuation-local-storage` / cls-hooked

The pre-Node-14 ecosystem standard. Rejected because:

- Deprecated by its maintainers (the README explicitly directs new
  code to `AsyncLocalStorage`).
- Built on older `async_hooks` primitives that have higher overhead
  than the native `AsyncLocalStorage` implementation.
- Adds an external runtime dependency for something Node core
  already provides.

The migration path from cls-hooked to `AsyncLocalStorage` is well-
trodden in the wider Node ecosystem; we skipped the intermediate
step entirely.

### Explicit context parameter

Every async function takes `ctx: TransactionContext` as its first
parameter; every caller threads it through manually:

```typescript
class OrderService {
  async placeOrder(ctx: TransactionContext, order: Order) {
    return this.repo.save(ctx, order);
  }
}
```

Rejected because:

- Breaks the public API surface — every method signature in user
  code grows a parameter.
- Defeats `@Transactional()`'s value proposition. The whole point
  of the decorator is "you don't think about transactions on every
  call site" — passing context defeats it.
- Forces a viral change: a service that picks up `@Transactional`
  for the first time forces every caller and callee to take the
  context parameter.
- Doesn't compose with NestJS's DI patterns: interceptors,
  guards, exception filters all run outside the user's parameter
  list.

This is the API shape libraries like Sequelize once forced; we
deliberately moved past it.

### Per-call manager API only (no decorator)

`manager.run(options, () => doWork())` always; no decorator.
This works *technically* — the decorator is only sugar over
`manager.run` — but cripples ergonomics:

- Method bodies grow indentation.
- The transaction signal lives at the call site, not on the method
  declaration; readers can't tell from a class definition which
  methods are transactional.
- Users coming from Spring expect `@Transactional` and its
  propagation modes.

We expose `manager.run` as an escape hatch for hot paths where the
decorator's overhead matters; the decorator stays the documented
default.

## Consequences

### Positive

- **Source-level ergonomics match Spring.** Users decorate methods,
  not call sites; the AsyncLocalStorage propagation is invisible.
- **Native, supported, performant.** Built-in to Node.js core,
  optimised by the V8 team, no external deps.
- **Composable with adapters.** Every adapter (TypeORM, future
  Prisma, future MikroORM) reads the active transaction from the
  same `TransactionContext` API; the abstraction is uniform.
- **Naturally per-request.** A NestJS server handling 1,000
  concurrent requests gets 1,000 independent ALS scopes for free
  — no manual request-scoping required.
- **Test-friendly.** Tests run inside the same ALS as production
  code; mocking is unnecessary at the context layer.

### Negative

- **Performance overhead.** Empirically <5% on typical workloads
  (ALS lookup is a hash-map access on a per-async-resource basis),
  but non-zero. Hot paths can pay it; the framework cannot escape
  it.
- **Lower bound on Node version.** Requires Node 20+ in the
  current package.json; the `AsyncLocalStorage.run` API has been
  stable since Node 14, but other Node 20-era performance
  improvements depend on it.
- **Subtle bugs when context is "lost".** Some uncommon async
  patterns (manual `EventEmitter` subscriptions outside the
  current scope, `setImmediate` chains in legacy code, ESM
  top-level await with deferred imports) can drop ALS context.
  These are rare; when they happen, debugging requires
  understanding `async_hooks`. Mitigation: documented escape
  hatches via `manager.run` and `getCurrentEntityManager`'s
  fallback parameter.

### Mitigations

- The `manager.run(options, fn)` programmatic API is exported as
  an escape hatch when hot paths can't afford the decorator's
  overhead.
- `getCurrentEntityManager(adapterInstance?, fallback?)` accepts
  a fallback `DataSource` so code that legitimately runs outside
  any transaction (one-off migration scripts, server bootstrap)
  still works.
- The observability hooks (`TransactionObserver`) emit on
  context entry/exit, giving operators a way to trace
  context-loss bugs in production.
- Future: an `OpenTelemetry` integration (not yet scheduled —
  see [`docs/roadmap/README.md`](../roadmap/README.md) "Future
  phases") will trace ALS scopes for production diagnostics.

## Notes

- This decision is upstream of every other ADR. ADR-005 (method
  wrapping strategy) builds on it: the three wrapping mechanisms
  all enter `manager.run(options, fn)` which wraps `als.run(...)`.
  ADR-002 (transactional events) builds on it: phase hooks live
  on the active store.
- `TransactionContext` was static in Phase 1 and remains static
  through Phase 14 (the per-DataSource keyed-Map approach in
  DD-023 supersedes a per-DS-ALS variant that was considered and
  rejected during Phase 14.2 planning — see ADR-018 for the
  reasoning).
