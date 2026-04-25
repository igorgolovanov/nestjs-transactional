# Conventions finalised during implementation

Empirically-discovered conventions surfaced during phase
iterations. These are not in the formal Design Decisions
(`docs/dd/`) — they fall below the bar for a DD or describe
implementation realities rather than design choices. They ARE
high-signal at session start: every entry is a gotcha that
caused at least one incident or wasted at least one debugging
session.

### Conventions finalised during implementation (not in the Design Decisions section above)

1. **Composite context key `${adapterName}:${instanceName}`.**
   `TransactionManager` writes every active transaction under a
   composite key, not just `instanceName`. Prevents collision between
   e.g. `typeorm:default` and `in-memory:default` when both are
   registered. Adapter-side helpers must compose their lookup key the
   same way — see `typeOrmContextKey` in
   `packages/typeorm/src/helpers/get-entity-manager.ts`.

2. **`TransactionalInterceptor` is part of the public API.**
   Earlier internal notes listed it as not exposed; in fact it is
   exported and typically wired via `TransactionalModule`. Advanced
   consumers can bind it manually on specific controllers instead
   of globally.

3. **`TransactionalModule.forRoot({ isGlobal: true })` is the default
   from Phase 14.10 onwards.** Single-call setups pairing with
   `TypeOrmTransactionalModule` rely on `isGlobal: true` so that
   `AdapterRegistry` is visible in the typeorm module's provider
   scope; multi-`forRoot` setups additionally rely on it for the
   second-and-later calls' per-DS providers to find the singletons
   the first call registered. Phase 14.10 flipped the option's
   default from `false` to `true` to match `OutboxModule` and
   remove a common-case footgun. Users who genuinely want a
   non-global module pass `isGlobal: false` explicitly and accept
   the per-import constraint.

4. **Test file layout is inconsistent across packages.** Core colocates
   `.spec.ts` next to source. TypeORM uses `test/unit/`,
   `test/integration/`, `test/shared/`. CQRS mostly colocates in `src/`
   with one exception (`test/unit/transactional-events-listener.decorator.spec.ts`
   — historical, can be moved to match). Pick one per package and stay
   consistent within the package.

5. **Session handoff notes live under `docs/sessions/`.** Read
   `docs/sessions/phase-2-complete.md` first when resuming after a
   long gap — it lists current state, open issues, and the next-session
   prompt sequence in more detail than this status block.

6. **Do NOT import `CqrsModule` directly alongside `CqrsTransactionalModule.forRoot()`.**
   The transactional module imports `CqrsModule` internally and overrides
   the `EventPublisher` DI token. A duplicate `CqrsModule` import in the
   consumer shadows the override — handlers inject the original
   `EventPublisher` from `CqrsModule` and aggregate events bypass the
   dispatcher. Documented in `packages/cqrs/README.md`.

7. **`CQRS_TRANSACTIONAL_OPTIONS` + `CQRS_HANDLER_WRAPPER_OPTIONS` are
   separate injection tokens.** The module-level token is a string
   (`'CQRS_TRANSACTIONAL_OPTIONS'`); the handler-wrapper-level one is a
   `Symbol`. `CqrsTransactionalModule.forRoot` builds the wrapper via
   `useFactory`, passing the resolved options directly — it does not
   wire the Symbol token. If you instantiate `CqrsHandlerWrapper`
   outside the module, provide the Symbol token yourself.

8. **`WRAPPED_MARKER` is shared via `Symbol.for('@nestjs-transactional/wrapped')`.**
   The core package does not re-export the symbol from its public
   barrel (internal per JSDoc), but re-deriving it in any package gives
   the same identity — `Symbol.for` is process-global. All three
   wrapping mechanisms (interceptor, methods-bootstrap, cqrs handler
   wrapper) check this marker before wrapping to prevent double-wrap.

9. **`OutboxModule.forRoot()` carries global config; event-class
   registration is `forFeature(eventTypes: Type[])` per feature
   module.** Matches `TypeOrmModule.forFeature(...)` ergonomics. Each
   `forFeature` call generates a unique Symbol token whose factory
   provider runs eagerly (singleton scope) during DI resolution and
   pushes the listed event classes into the singleton
   `EventTypeRegistry`. Multiple `forFeature` calls accumulate.
   Empty arrays are a no-op. Duplicate registrations throw at
   bootstrap with the offending class name. By the time any
   `onModuleInit` hook runs (e.g.
   `ExternalizationRegistry.onModuleInit`), every `forFeature`
   factory has already executed — natural NestJS lifecycle ordering
   makes the registry fully populated before any consumer reads it.
   Do NOT pass `eventTypes` to `forRoot` — that field was removed in
   Phase 13. Move event registrations to the feature modules that
   own the event classes.

10. **Multi-adapter naming: dataSource name is the primary
    identifier across every package; default is `'default'`.** Tokens
    are deterministically derived via the `getXxxToken(dataSource)`
    helpers exported from `@nestjs-transactional/core`. The convention
    is `'{Component}{DataSource}'` (PascalCase, dataSource
    capitalised — e.g. `'BillingTransactionManager'`,
    `'DefaultOutboxEventPublisher'`); dataSource `'default'` produces
    the `'Default…'` prefix. Inject decorators
    (`@InjectTransactionManager(dataSource?)`,
    `@InjectOutboxPublisher(dataSource?)`, etc.) accept the same
    optional dataSource argument with the same default. Adapter
    constructors take a dataSource name
    (`new TransactionalTypeOrmAdapter('billing')`); each dataSource
    has its own `AsyncLocalStorage` so cross-dataSource calls do not
    silently enrol into a sibling transaction (DD-023). Distributed
    transactions across dataSources are explicitly NOT supported —
    cross-dataSource consistency goes through the outbox, see
    ADR-018. Phase 14 lands the implementation; Phase 14.0 is the
    documentation-only preparation iteration.

11. **Two-commit phases must verify both commits before closure.**
    Phases that ship in two commits (code + docs) require explicit
    verification that BOTH commits landed before the phase is marked
    complete. "Done" reported on the code commit alone is incomplete
    — the docs commit drifts into the next phase's session and gets
    forgotten. Pattern observed: Phase 14.3.2 (code shipped 0ecb0e4
    on 2026-04-27, ADR-019 docs ~10h later as 8318a64); Phase 14.10
    (code shipped fd477fa on 2026-04-27, docs deferred and
    eventually bundled with Phase 14.11 as a single docs commit).
    Mitigation: end-of-phase checklist explicitly asks "did the
    docs commit land?" before moving on. Bundling consecutive
    cleanup phases' docs into one commit (this commit, for example)
    is acceptable once both code commits have shipped — but the
    bundle must still happen before another non-cleanup phase
    starts, otherwise it slips again.

12. **Patches in `@nestjs-transactional/typeorm` install at
    module-load time, NOT at `forRoot` factory time** (Phase 14.20).
    Importing `@nestjs-transactional/typeorm` triggers
    `applyAllPatches()` as a side effect of evaluating
    `typeorm-transactional.module.ts`. Reason: NestJS resolves
    providers in dependency order; a `useFactory` provider that
    calls `dataSource.getRepository(Entity)` (e.g.
    `@InjectRepository`'s internal factory) may run BEFORE
    `TypeOrmTransactionalModule.forRoot`'s factory if it has no
    DI dependency on the latter. A Repository constructed before
    patches are installed gets `this.manager = manager` as an
    own-property, which permanently shadows the prototype getter
    we install later. Module-load activation guarantees patches
    are in place before any DI factory observes
    `Repository.prototype`. Pattern matches typeorm-transactional's
    `initializeTransactionalContext()` semantics — make the
    import itself the activation point. Idempotent: install-once
    flags inside each patch module make re-imports (e.g. via
    pnpm hoisting glitches) safe.

13. **`TypeOrmTransactionalModule.resetForTesting` resets the
    managed-DataSource WeakSet only — prototype patches stay
    installed for the process lifetime** (Phase 14.20). Reverting
    a prototype patch by deleting the descriptor would silently
    break Repository instances constructed under the patched
    setter (those have no own-property `manager`; deletion leaves
    `repo.manager === undefined`). The WeakSet flip is the safe
    isolation lever — cached repositories from a prior test fall
    through the patched getter to their captured original manager
    (autocommit). Tests that need full isolation destroy and
    recreate the `DataSource` between cases (the typical pattern).
    Same trade-off documented in typeorm-transactional issues
    #34/#51; we make the trade-off survivable instead of silent
    via the install-once contract.

14. **Tier 2+ examples ship one-per-commit** (Phase 14.8a closure,
    decided 2026-05-08). Tier 1 (Phase 14.8a) bundled 2 examples
    per commit because three of the four were small (~+400 LoC
    each) and naturally paired (basic-transactional/basic-outbox in
    Commit 1; basic-typeorm-outbox alone in Commit 2; basic-cqrs +
    examples/README.md index in Commit 3; QueryHandler gap-fill in
    Commit 4). Tier 2+ examples are larger (multi-DS / Kafka /
    docker-compose stacks) and benefit from independent review
    granularity. Pattern: audit at the start of each tier, then
    one example per commit, then a closing docs commit recording
    the tier completion.

    **LoC envelope**: Tier 2 examples landed 700-1000 LoC per
    commit; Tier 3 examples landed 891-1184 (broker stack +
    externalization wiring add ~250-300 LoC over Tier 2 baseline
    + the README needs more space for the architectural surface).
    The original +900 cap was a Tier 1 hangover; from Tier 3 onward
    the realistic envelope is +1200 per commit and the audit should
    flag deviations beyond that. Multi-DS examples sit at the
    upper edge of the envelope (1100-1200 expected for Tier 3+
    multi-DS); single-DS examples should fit under +1000.
    Tier 4 actuals: 1149 / 884 / 688 / 896 — the saga (1149) sits
    at the upper edge due to 4-step domain + compensation, the
    no-outbox/no-cqrs `read-write-separation` (688) sets the new
    floor for single-axis examples.

15. **`OutboxEventPublisher.publish` is a silent no-op when no
    listener is registered for the event type.** Surfaced
    2026-05-10 in Phase 14.8d (`testing-patterns` outbox-unit
    tier first iteration). `OutboxModule.forFeature([...])` is
    necessary but not sufficient — the publisher only writes a
    publication row when at least one decorated listener
    (`@OutboxEventsHandler` or `@IntegrationEventsHandler`) is
    registered for the event class. By design (avoids buffering
    events nobody consumes), but it surprises tests that try to
    assert "the service called publish, therefore the publication
    row exists." The mitigation: any unit test asserting on
    `PublishedEvents` / `AssertablePublishedEvents` must register
    at least one listener. A stub class is fine — see
    `examples/testing-patterns/test/wallet-outbox.spec.ts`'s
    `TestAuditListener` for the pattern.

16. **`@TransactionalEventsHandler` (cqrs in-memory dispatcher)
    does NOT receive events published through
    `OutboxEventPublisher.publish` directly.** Surfaced 2026-05-10
    in Phase 14.8d (`testing-patterns` integration tier first
    iteration). The in-memory dispatcher consumes from cqrs's
    `EventBus.publish` / `AggregateRoot.commit()` paths; the
    outbox consumes from `OutboxEventPublisher.publish`. To
    bridge: either emit through cqrs (which `HybridEventPublisher`
    fans to both paths when both are wired), or use
    `@IntegrationEventsHandler` (outbox-routed when `OutboxModule`
    binds the registrar). The example carries the right shape
    after the iteration: `WalletProjection` is now
    `@IntegrationEventsHandler`.

17. **Subpath imports require `module: Node16` +
    `moduleResolution: Node16` + `isolatedModules: true` in the
    consuming `tsconfig`.** Surfaced 2026-05-10 in Phase 14.8d
    (`testing-patterns` first build). The monorepo
    `tsconfig.base.json` uses `module: CommonJS` /
    `moduleResolution: node` which cannot read package.json
    `exports` subpaths — TS errors with `TS2307: Cannot find
    module '@nestjs-transactional/core/testing' or its
    corresponding type declarations`. Consuming examples must
    override. `basic-cqrs` already does (the canonical pattern);
    `testing-patterns` followed. A future cleanup may flip the
    base config to `Node16` and propagate; out of scope for the
    examples-only Phase 14.8.

18. **Inner-method indirection for `@Transactional({ dataSource })`
    inside an `@IntegrationEventsHandler`.** Surfaced 2026-05-10 in
    Phase 14.8e (`e-commerce-orders`). The cqrs scanner captures
    `instance.handle.bind(instance)` in `OnModuleInit`;
    `TransactionalMethodsBootstrap` wraps methods at
    `OnApplicationBootstrap` — strictly later. A naive
    `@Transactional({ dataSource: 'inventory' })` on the public
    `handle()` does NOT take effect — the bound reference is the
    pre-wrap original. **Workaround**: `handle()` (un-decorated)
    delegates to a private `processInInventoryTx()` (decorated).
    The `this.processInInventoryTx(event)` call resolves the
    method at invocation time, by then the wrapped version is
    installed on the instance. Single-DS handlers (where the
    worker's outer `REQUIRES_NEW` transaction is on the same DS as
    the listener target) don't need the indirection — the outer tx
    already covers the work. Canonical pattern in
    `examples/e-commerce-orders/src/inventory/release-stock.handler.ts`
    and `billing/charge-payment.handler.ts`. The framework may
    rewire scanner timing in a future phase; the indirection is
    safe regardless and is the recommended pattern for any
    cross-DS work inside a handler.

19. **`@Externalized` events still need a local
    `@OutboxEventsHandler` listener to materialise a publication
    row.** Surfaced 2026-05-10 in Phase 14.8e (`e-commerce-orders`).
    Convention #15 (silent no-op without listener) extends to
    externalization: the externalizer pipeline reads from
    `event_publication`, but the publication is only created when
    at least one listener is registered for the event class. The
    `@Externalized` decorator alone is not enough. **Pattern**: a
    stub `@OutboxEventsHandler` whose `handle()` body is empty (or
    carries an audit-trail / read-model side effect). Canonical
    empty-stub form in
    `examples/e-commerce-orders/src/orders/externalized-event-stub.ts`.

20. **`CqrsTransactionalModule` does NOT export `CommandBus` /
    `QueryBus` to consumers.** Surfaced 2026-05-10 in Phase 14.8e
    (`e-commerce-orders`). The module imports `CqrsModule`
    internally and overrides `EventPublisher` (Convention #6); a
    duplicate `CqrsModule.forRoot()` in the consumer would shadow
    the override. Consequently the module deliberately scopes
    `CqrsModule`'s exports inward — REST controllers and other
    non-handler consumers cannot inject `CommandBus.execute(...)`.
    **Pattern**: inject the command and query handlers directly
    and call `handler.execute(...)` / `handler.handle(...)`.
    Canonical pattern in
    `examples/e-commerce-orders/src/orders/orders.controller.ts`.

21. **`OutboxModule.forRootAsync({ repository })` takes
    `repository` at the OPTIONS level, NOT in the async factory
    result.** Surfaced 2026-05-10 in Phase 14.8e
    (`async-config-from-environment`). Provider tokens must be
    declared at module-build time, so the module reads
    `repository` (and `serializer`) from the options argument
    synchronously. The async factory's return shape
    (`OutboxModuleAsyncFactoryResult`) only carries *runtime
    tunables* — `processor`, `staleness`, `republishOnStartup`,
    `startupBatchSize`, `completionMode`. Putting `repository`
    inside `useFactory`'s return is silently ignored; the module
    falls back to `InMemoryEventPublicationRepository`, the
    publication never reaches Postgres, and the worker never
    delivers anything. The silence is double-layered: misplaced
    field is dropped without a warning, and `publish` is then a
    silent no-op for events with no in-memory listener
    (Convention #15 again). Canonical correct placement in
    `examples/async-config-from-environment/src/app.module.ts`.

22. **`TypeOrmTransactionalModule.forRootAsync` registers via
    `OnModuleInit`, not via a `useFactory` provider** (fixed
    2026-05-10, same Phase 14.8e session that surfaced it).
    Originally surfaced as a bootstrap failure
    (`TypeError: this.postgres.Pool is not a constructor` cascading
    from `markAsManaged(undefined)`) when `forRootAsync` was used
    alongside `TypeOrmModule.forRootAsync`. **Root cause**: the
    historical registration was a `useFactory` provider that
    pulled the DataSource via `moduleRef.resolve(...)` (or
    `moduleRef.get(...)`) at factory-resolution time — but
    `@nestjs/typeorm`'s DataSource provider is async and may not
    yet be settled when the framework's `useFactory` providers
    run. `markAsManaged` was therefore called with `undefined`,
    which threw "Invalid value used in weak set" inside our weak
    registry. The thrown error cascaded through `@nestjs/typeorm`'s
    retry loop into a malformed PostgresDriver state on the next
    attempt, producing the surface error.
    **Fix shape**: extract the registration into an
    `@Injectable() OnModuleInit` class generated per
    `forRootAsync` call (each call gets a fresh class identity for
    DI uniqueness). `OnModuleInit` runs after every provider
    instantiation, so `moduleRef.get(getDataSourceToken(name))`
    returns the real DataSource. The synchronous `forRoot()` path
    is unchanged — it injects `getDataSourceToken(name)` directly
    in its `useFactory.inject` array, which forces NestJS to
    resolve the DataSource first, so the gap never opened there.
    Pinned by the regression spec
    `packages/typeorm/test/integration/forrootasync.integration.spec.ts`
    (3 cases: `TypeOrmModule.forRootAsync` alone; + sync
    `forRoot()`; + async `forRootAsync({ ... })`). Keep this entry
    as a historical record so future refactors know why the
    OnModuleInit indirection exists.

23. **dotenv refuses to overwrite an existing `process.env` key.**
    Surfaced 2026-05-10 in Phase 14.8e
    (`async-config-from-environment` integration tests). Two
    consequences: (a) tests that load multiple `.env` files
    sequentially in the same Jest worker get cross-contamination —
    the FIRST file's values mask later files' values. The
    async-config example snapshots managed env keys at
    `beforeAll`, restores between tests via a small
    `restoreEnv(snapshot)` helper. (b) In production, exported
    shell variables override `.env` files — that's *intended*
    (secrets-manager-injected env should win over a committed
    file), but operators sometimes forget. Don't rely on `.env`
    to "reset" a variable that has already been set in the
    deployment environment.

24. **Outbox graceful drain requires a user-side
    `OnApplicationShutdown` complement.** Surfaced 2026-05-10 in
    Phase 14.8e (`graceful-shutdown`). The framework's
    `OutboxProcessingModule.onApplicationShutdown` calls
    `processor.stop()` synchronously — sets `running = false` and
    cancels the next-poll `setTimeout`. It does NOT await the
    `processBatch()` Promise that the previous tick already
    dispatched. NestJS proceeds to dispose the DataSource provider;
    an in-flight `processOne()` writing
    `PROCESSING → COMPLETED` can race the pool teardown, leaving
    the row stuck in `PROCESSING` until the staleness monitor
    recovers it on the next boot. **Pattern**: a user-side
    `OutboxDrainService` that implements `OnApplicationShutdown`
    async, idempotently re-calls `processor.stop()` (safe
    regardless of NestJS shutdown ordering between sibling
    providers), then polls
    `EventPublicationRepository.findIncomplete()` until no row is
    in `PROCESSING` state or `DRAIN_TIMEOUT_MS` elapses (10 s
    default — tune to your platform's grace period; Kubernetes
    default `terminationGracePeriodSeconds` is 30 s, leave 5–10 s
    margin for the rest of the shutdown chain). Canonical pattern
    in `examples/graceful-shutdown/src/shutdown/outbox-drain.service.ts`.
