# ADR-018: Multi-adapter architecture — dataSource-name-keyed registration

- **Status**: Accepted (final form after Phase 14.20 / 14.21)
- **Date**: 2026-04-27
- **Related**:
  - ADR-005 (method wrapping strategy)
  - ADR-007 (outbox architecture: core + persistence split)
  - ADR-019 (`OutboxModule` multi-`forRoot` registration pattern)
  - DD-005 (multi-DataSource as a first-class feature)
  - DD-020 (multi-adapter through dataSource-name identifier)
  - DD-021 (adapter constructor accepts dataSource name)
  - DD-022 (inject decorators with dataSource parameter)
  - DD-023 (independent transaction contexts per dataSource)
  - DD-024 (smart `OutboxEventPublisher` facade)
  - Phase 14 roadmap entry: [`docs/roadmap/README.md`](../roadmap/README.md)

## Context

The original single-adapter architecture supported one transactional
adapter *instance* per process. Multiple `DataSource`s under the same
TypeORM adapter were possible via an internal `instanceName` field
(see DD-005), but there was no story for:

1. **Multiple `DataSource`s of the same ORM that need fully independent
   outbox stacks** — e.g. `billing` events committed against the
   billing DB and `inventory` events against the inventory DB, with
   separate `event_publication` tables and separate workers.
2. **Different ORMs running in the same process** — e.g. TypeORM for
   the main relational data, Prisma for an audit store, Mongoose for
   user-profile documents. Each needs its own transactional contract
   and its own outbox.
3. **Module-per-database boundaries in a modular monolith** — each
   bounded-context module owns its DB, its outbox, and its event
   publications. Cross-module integration is via durable events, not
   shared transactions.

Real-world cases that motivated this:

- Modular monoliths where each module ships with its own schema (and
  potentially its own ORM choice).
- Migration scenarios where a team is moving piecewise from ORM A to
  ORM B and needs both alive in the same process for some weeks.
- Reporting / analytics / audit stores that intentionally live in a
  different storage technology than the OLTP main store.

The single-adapter design conflated "the adapter" with "the DI scope"
— one `TransactionManager`, one `AdapterRegistry`, one `OutboxModule`,
one `EventPublicationRepository`. Multi-adapter required a naming
contract that distinguishes adapter *instances* and a DI contract
that lets users inject the right one.

## Decision

The shipped architecture rests on the ten points below. They form a
cohesive design — accepting any one in isolation does not make sense.
Points 9 and 10 capture the Phase 14.20 / 14.21 architectural
extensions to the original eight; the [Revision history](#revision-history)
section at the end records the phase boundaries that updated this ADR.

### 1. dataSource name as primary identifier

A string `dataSource` name keys every adapter instance, every
transactional context, every outbox stack. Default `'default'`
preserves the single-adapter ergonomics — users who never register a
non-default name see no change.

The dataSource name is what users *think* in (the name of their DB,
not "the TypeORM adapter for the billing DB"). It generalises
cleanly across ORMs: a `'billing'` dataSource might be TypeORM
today and Prisma tomorrow without renaming.

### 2. Token-based DI resolution

DI tokens are deterministically derived from the dataSource name.

```ts
getTransactionManagerToken('billing')  // → 'BillingTransactionManager'
getTransactionManagerToken()           // → 'DefaultTransactionManager'
```

Same pattern for `OutboxEventPublisher`, `EventPublicationRepository`,
`EventTypeRegistry`, processor, staleness monitor, etc. Matches
`@nestjs/typeorm`'s `getRepositoryToken(Entity, dataSource)` and
`getDataSourceToken(name)` conventions — users coming from
`@nestjs/typeorm` find the pattern familiar.

Token utility functions live in `@nestjs-transactional/core` so all
packages produce identical token strings for the same dataSource name.

### 3. Per-dataSource module registration via multi-`forRoot`

Every module in the family — `TransactionalModule`,
`TypeOrmTransactionalModule`, `OutboxModule`, `OutboxTypeOrmModule` —
is called once per dataSource. Each call registers a complete set of
providers under dataSource-derived tokens. Two calls produce two
disjoint sets — no cross-talk.

```ts
@Module({
  imports: [
    TypeOrmModule.forRoot({ name: 'billing',   /* ... */ }),
    TypeOrmModule.forRoot({ name: 'inventory', /* ... */ }),

    TransactionalModule.forRoot({ isGlobal: true }),

    TypeOrmTransactionalModule.forRoot({ dataSource: 'billing',   isDefault: true }),
    TypeOrmTransactionalModule.forRoot({ dataSource: 'inventory' }),

    OutboxTypeOrmModule.forRoot({ dataSource: 'billing' }),
    OutboxTypeOrmModule.forRoot({ dataSource: 'inventory' }),

    OutboxModule.forRoot({
      dataSource: 'billing',
      repository: typeOrmEventPublicationRepositoryProvider({ dataSource: 'billing' }),
    }),
    OutboxModule.forRoot({
      dataSource: 'inventory',
      repository: typeOrmEventPublicationRepositoryProvider({ dataSource: 'inventory' }),
    }),
  ],
})
export class AppModule {}
```

The default registration (`dataSource` omitted, or explicitly
`'default'`) keeps the single-adapter ergonomic shape and serves the
single-adapter case unchanged. Cross-call coordination of singletons
(smart facade, processing bundle, listener scanner) lives in
static-class storage — see [ADR-019](019-outbox-multi-forroot-pattern.md)
for the mechanism. Phase 14.10 applied the same multi-`forRoot`
pattern to `TransactionalModule.forRoot` so the entire family follows
one convention.

### 4. Adapter construction is module-internal

Adapter instances are constructed by the per-ORM module's `forRoot`
factory, not by user code. Users supply the *dataSource name*; the
module resolves the underlying connection (e.g. TypeORM `DataSource`
via `@nestjs/typeorm`'s `getDataSourceToken(name)`), constructs the
adapter, and registers it under `getTransactionalAdapterToken(name)`
in the core `AdapterRegistry`.

The original draft of this ADR exposed `new TransactionalTypeOrmAdapter('billing')`
as user-facing API. Phase 14.20 collapsed that to module-internal:
users never see the adapter class. The module-internal construction
path keeps the adapter and its connection co-located, simplifies
multi-DS registration, and matches the `@nestjs/typeorm` mental model
where DataSource registration is `forRoot`-only.

### 5. Inject decorators with dataSource parameter

```ts
class BillingService {
  constructor(
    @InjectTransactionManager('billing')
    private readonly txManager: TransactionManager,
    @InjectOutboxPublisher('billing')
    private readonly outbox: OutboxEventPublisher,
  ) {}
}
```

`@InjectTransactionManager()` (no argument) defaults to `'default'` —
single-adapter consumers are unaffected. Mirrors
`@InjectRepository(Entity, dataSource?)` from `@nestjs/typeorm`.

These decorators are thin wrappers over `@Inject(token)` where
`token = getTransactionManagerToken(dataSource)`. They exist for
discoverability and IDE hinting, not because token-based `@Inject` is
insufficient.

### 6. `@Transactional` accepts a dataSource option

```ts
@Transactional({ dataSource: 'billing' })
async chargeCustomer(...) { ... }
```

The wrapping mechanism (interceptor, methods bootstrap, CQRS handler
wrapper — all three from ADR-005) reads the metadata, resolves the
matching `TransactionManager` via DI, and runs the method in that
manager's `run()`. Without `dataSource`, the default manager is used.

### 7. Independent transaction contexts

A single shared `AsyncLocalStorage` carries a per-scope store whose
active-transaction `Map` is keyed by dataSource name. Cross-dataSource
enrolment is structurally impossible because the keys are disjoint
namespaces — code looking up `'billing'` cannot retrieve a transaction
registered under `'inventory'`. Crossing a dataSource boundary inside
a single async call stack creates a *separate* `Map` entry; there is
no automatic enrolment of the second manager into the first manager's
transaction.

The keying-not-multiple-ALS shape is deliberate. Spinning up a
dedicated `AsyncLocalStorage` instance per dataSource would deliver
the same guarantee (disjoint state) at the cost of cascading the
static→instance migration of `TransactionContext` through every
consumer (adapter helpers, CQRS dispatcher, outbox publisher) — for
no behavioural improvement. DD-023 carries the same rationale.

The user-facing implication: cross-dataSource consistency is an
*application-level* concern. The recommended pattern is "write to
dataSource A, publish a durable event, consume the event in
dataSource B" — i.e. the outbox stack is the consistency boundary
between dataSources. The single-unit atomicity contract from DD-019
applies to each dataSource independently.

### 8. Smart `OutboxEventPublisher` facade detects the active dataSource

A facade wrapper around the per-dataSource publishers detects which
dataSource has an active transaction in the current async context
and routes the event accordingly:

```ts
@Transactional({ dataSource: 'billing' })
async chargeCustomer() {
  // No explicit dataSource — the facade picks 'billing' from context.
  this.publisher.publish(new InvoiceIssuedEvent(...));
}
```

Explicit override is supported when the implicit behavior is wrong:

```ts
this.publisher.publish(event, { dataSource: 'inventory' });
```

This keeps single-adapter call sites unchanged (the facade resolves
to the only registered publisher) while making multi-adapter
publishing ergonomic — no per-call `@Inject` plumbing.

If no transaction is active and no explicit dataSource is given, the
facade falls back to `'default'` and (per the single-adapter rules)
fails fast if `'default'` is not registered.

The facade late-binds per-DS publishers via `OnModuleInit` +
`ModuleRef.get` so it works under multi-`forRoot` where the full set
of dataSources isn't known at module-build time. See ADR-019 § 4 for
the late-binding mechanism.

### 9. Transparent transactional repositories (Phase 14.20)

`@InjectRepository(Entity)` Repositories automatically dispatch
through the active `@Transactional()` scope's `EntityManager`. No
`getCurrentEntityManager()` calls in user service code — the
transparent dispatch covers `repo.save(...)`, `repo.find(...)`, all
30+ Repository operations, custom `Repository.extend(...)` classes,
`TreeRepository`, plus the `@InjectEntityManager() em.getRepository(E).save(...)`
and `@InjectDataSource() ds.getRepository(E).save(...)` patterns.

The mechanism is prototype-level patching modelled on the
`typeorm-transactional` library (~166K weekly npm downloads):

- `Repository.prototype.manager` — getter / setter pair. The setter
  intercepts the `Repository` constructor's `this.manager = manager`
  and stashes the value under a hidden `Symbol.for(...)` key; the
  getter consults `TransactionContext.getActiveTransactionByDataSource(name)`
  and returns the active transactional `EntityManager` when one exists
  for this Repository's dataSource. Because every TypeORM `Repository`
  method dispatches as `this.manager.<method>(target, ...)` under the
  hood, this single getter patch covers every Repository operation.
- `EntityManager.prototype.getRepository` — wrapper that stamps the
  freshly-resolved Repository with the same hidden key, pointing at
  the calling EntityManager. Makes
  `@InjectEntityManager() em.getRepository(E).save(...)` transactional.
- `Repository.prototype.extend` — wrapper preserving the stamp on
  extended (custom) Repository classes.

Plus per-instance patches on each managed `DataSource` (`manager`
getter, `query`, `createQueryBuilder` — to inject the active
QueryRunner). The `manager` patch is per-instance because TypeORM
sets `this.manager` as an own-property in the `DataSource`
constructor; a prototype-level getter would be shadowed.

Patches install as a side effect of importing
`typeorm-transactional.module.ts` (idempotent install-once flags
inside each patch module). NestJS resolves providers in dependency
order, and a `useFactory` provider that calls
`dataSource.getRepository(Entity)` may run BEFORE
`TypeOrmTransactionalModule.forRoot`'s factory if it has no DI
dependency on the latter. A Repository constructed before patches
are installed gets its `this.manager = manager` assignment as an
own-property, which permanently shadows the prototype getter.
Module-load activation guarantees patches are installed before any
DI factory observes `Repository.prototype`.

Cross-DS isolation (DD-023) is preserved — a Repository bound to
dataSource A inside a `@Transactional({ dataSource: 'B' })` method
autocommits, because its patched `manager` getter looks up the
active transaction for dataSource A, finds none, and falls back to
its captured original manager. Distributed transactions across
dataSources remain unsupported; cross-DS atomicity routes through
the outbox.

Documented limitations live in
[`docs/known-limitations.md`](../known-limitations.md):
`@InjectEntityManager() em.save(Entity, ...)` direct calls and
`BaseEntity` static methods are not patched and require the
`getCurrentEntityManager()` escape hatch or the Repository pattern.

### 10. Outbox persistence module reshape (Phase 14.21)

`OutboxTypeOrmModule.forRoot({ dataSource?, isDefault? })` mirrors
the Phase 14.20 `TypeOrmTransactionalModule.forRoot` shape. The
underlying `DataSource` is resolved from DI via `@nestjs/typeorm`'s
`getDataSourceToken(name)`. Each `forRoot` call registers
`TypeOrmEventPublicationRepository` under a per-DS private token
(`getEventPublicationRepositoryProviderToken(name)`).

The cross-module aliasing bridge
`typeOrmEventPublicationRepositoryProvider({ dataSource })` is
preserved because `OutboxModule.forRoot` ALWAYS registers something
under the per-DS `getEventPublicationRepositoryToken(name)` token
(defaults to `InMemoryEventPublicationRepository` when no
`repository` option is passed). `OutboxTypeOrmModule.forRoot` cannot
register under the same token directly — both modules are `@Global()`
and a duplicate `@Global()` provider for the same token causes
NestJS DI conflicts. The bridge function returns a `useExisting`
Provider that aliases the official outbox token to the private
TypeORM-backed token.

This preserves the architectural separation: outbox-core has no
import dependency on outbox-typeorm; the user's `AppModule`
explicitly opts in to TypeORM persistence by passing the bridge
provider through `OutboxModule.forRoot({ repository, ... })`.

The outbox atomicity invariant — business INSERT and
`event_publication` INSERT inside a `@Transactional()` method commit
atomically, and rollback discards both — holds via two parallel
mechanisms reaching the same active `EntityManager`:

1. The Phase 14.20 patched `Repository.prototype.manager` getter on
   the `@InjectRepository` business Repository routes through the
   active transactional `EntityManager`.
2. `TypeOrmEventPublicationRepository`'s explicit
   `getCurrentEntityManager(dataSourceName, fallback)` call routes
   through the same active EM via `TransactionContext`.

A dedicated
[`atomicity.integration.spec.ts`](../../packages/outbox-typeorm/test/integration/atomicity.integration.spec.ts)
regression net pins the contract against real Postgres.

## Alternatives considered

### Adapter type as identifier (e.g. `'typeorm'`, `'prisma'`)

Rejected. This collapses two distinct concepts — *which ORM* and
*which database* — into one identifier. It cannot represent two
TypeORM-backed dataSources (the most common multi-adapter case in
practice), and it forces users to think in our internal taxonomy
("which adapter implementation") rather than their domain
("which database").

### Distributed transactions across dataSources (XA / 2PC)

Rejected. XA support in Node.js drivers is patchy, semantics differ
across stores, and the operational cost (XA-aware brokers, recovery
procedures, monitoring) is significant. The patterns that motivated
this ADR — modular monolith, audit-store split, ORM migration — are
all served by per-dataSource consistency + durable events for
cross-dataSource integration.

If a future caller really needs cross-store atomicity, they can model
it explicitly with a saga / process-manager pattern on top of the
outbox (compensating actions on failure). We expose the building
blocks; we do not pretend to solve distributed transactions.

### Hidden auto-detection without explicit dataSource

Rejected. "Whichever dataSource has an active transaction" is fine
for *outbox publishing inside a `@Transactional` body* (point 8 above
— that's the smart-facade path), but it breaks down for boundary
cases:

- Outside any transaction (which dataSource does the event belong to?)
- Two dataSources active at once via nested `@Transactional` calls
  with different `dataSource` options
- Application bootstrap code, tests, scripts

For non-publishing APIs (`@InjectTransactionManager`,
`@Transactional({ dataSource })`), explicit-better-than-implicit wins
unambiguously. Auto-detection there would create confusing failures
("why did this run on `billing`?") that are hard to debug.

### Configuration via DI only (no decorator support)

Rejected. The decorator-based API
(`@Transactional`, `@InjectRepository`-style decorators) is idiomatic
NestJS, ships well, and matches what users already know from the
NestJS ecosystem. Forcing the multi-adapter API to be DI-only would
introduce a parallel pattern — strictly worse usability for the
single-adapter case (the vast majority of users).

The decorators in points 5 and 6 *are* DI under the hood. They just
add a thin discoverable surface on top.

### User-constructed adapter instances

Rejected during Phase 14.20. The original draft exposed
`new TransactionalTypeOrmAdapter(dataSource)` as user-facing API.
Real use exposed two issues: users had to thread the same dataSource
name through both the adapter constructor AND the module options
(easy to mismatch); and the adapter had to be hand-wired in the
provider list, doubling the multi-DS registration boilerplate.
Module-internal construction (point 4 above) eliminates both.

## Consequences

### Positive

- **Production-grade multi-database support**. The patterns
  motivating this ADR (modular monolith, audit-store split, ORM
  migration) all have first-class support — verified end-to-end by
  the [`e-commerce-orders`](../../examples/e-commerce-orders/)
  flagship and the multi-DS tier-2 examples.
- **Multi-ORM combinations work without internal special-casing**.
  Adapter packages share a contract; new adapters slot in following
  the [Adapter pattern conventions](#adapter-pattern-conventions)
  below.
- **Idiomatic NestJS**. The `getXxxToken(dataSource)` /
  `@InjectXxx(dataSource)` pattern matches `@nestjs/typeorm` and
  `@nestjs/mongoose`, so users coming from that ecosystem don't
  learn a new vocabulary. Multi-`forRoot` is the same shape every
  multi-instance NestJS module ships.
- **Single-adapter users are unaffected**. The default `'default'`
  threading is transparent.
- **Outbox stacks naturally partition along dataSource lines**.
  No contention on a single `event_publication` table when multiple
  bounded-context modules emit events.
- **Transparent transactional repositories collapse the surface
  area**. Phase 14.20 removed the most common reason for users to
  reach for `getCurrentEntityManager()` — Repository methods now
  participate transparently. The escape hatch remains for the
  documented limitations.

### Negative

- **API surface refactoring touched every package**. The Phase 14
  iterations migrated `core`, `typeorm`, `cqrs`, `outbox`,
  `outbox-typeorm`, `outbox-microservices`, plus all examples and
  cross-package consumers. The breaking-changes itemisation lives
  in [`docs/migration/multi-adapter.md`](../migration/multi-adapter.md).
- **Verbose configuration for multi-database setups**. Multi-DS apps
  call `TypeOrmTransactionalModule.forRoot`, `OutboxTypeOrmModule.forRoot`,
  and `OutboxModule.forRoot` once per dataSource — three calls × N
  dataSources. Mitigated by the single-call shorthand for the
  default-DS case and by configuration locality (each bounded-context
  module imports its own `forRoot` for its own dataSource).
- **Cross-dataSource transactions explicitly unsupported**. Users
  expecting Spring's `@Transactional` behavior across multiple
  datasources will need to rethink in terms of events. Documented
  prominently in the migration guide.
- **Token-naming convention is now a stable public API**. Once
  shipped, changing `getTransactionManagerToken` is a breaking
  change for anyone who hand-built tokens around the same string.
- **Patch-based transparent repositories carry a runtime footprint**.
  The Phase 14.20 prototype patches install at module load and
  remain installed for the process lifetime; `resetForTesting`
  drops the managed-DataSource WeakSet but does not delete the
  prototype getter. The trade-off pays back via the API
  simplification.

### Neutral

- The convention `'{Component}{DataSource}'` (PascalCase, dataSource
  capitalised) is the standard pattern for any future ORM adapter
  package. Consistency is the win; the cost is documenting it once.
- Adapter packages must follow a consistent constructor contract
  (`new TransactionalXxxAdapter(connection, dataSource: string)`,
  module-internal), making it easier to author new adapters.

## Adapter pattern conventions

Confirmed during Phase 14.4 audit and codified here as guidance for
future ORM adapters (`@nestjs-transactional/prisma`,
`@nestjs-transactional/mongoose`, etc.):

- **Adapters receive the concrete native connection directly**.
  TypeORM's adapter takes a `DataSource` instance (resolved from DI
  via `@nestjs/typeorm`'s `getDataSourceToken(name)`); a Prisma
  adapter would take a `PrismaClient`; a Mongoose adapter would take
  a `Connection`. The user already has these — usually instantiated
  from their own `forRoot` config via `@nestjs/typeorm`,
  `nestjs-prisma`, etc. — and the *module*'s `forRoot` factory
  resolves them via DI before constructing the adapter.
- **The adapter is created at `forRoot` factory time**, bound to the
  connection at construction. `TypeOrmTransactionalModule.forRoot`
  builds a `TypeOrmTransactionAdapter(dataSource, dataSourceName)` in
  its provider factory; future ORM modules follow the same shape
  (`PrismaTransactionalModule.forRoot({ dataSource })`,
  `MongooseTransactionalModule.forRoot({ dataSource })`). User code
  never constructs an adapter directly.
- **The dataSource identifier is a string flowing through every
  consumer**. The adapter exposes it as `dataSourceName`; the user
  passes it via `@Transactional({ dataSource })`,
  `getCurrentEntityManager(dataSource)`, and the per-DS inject
  decorators. The same string round-trips cleanly across decorator →
  manager → registry → adapter → helper.

This pattern keeps adapter packages thin: they wrap the native
connection's transaction primitive (`DataSource.transaction`,
`prisma.$transaction`, `connection.transaction`, ...) and translate
to the core's `runInTransaction` / `runInSavepoint` callback shape.
No DI token wiring, no provider-graph gymnastics inside the adapter.

## Vocabulary asymmetry

The codebase uses two distinct terms depending on context:

- **`dataSource`** — when the surrounding interface only needs the
  string identifier. Examples: `@Transactional({ dataSource })`,
  `OutboxModule.forFeature(events, { dataSource })`,
  `manager.run({ dataSource })`. This is the primary user-facing
  spelling.
- **`dataSourceName`** — when the surrounding interface ALSO holds
  the connection instance and the two would collide on the same
  field name. Examples: `TransactionalAdapter.dataSourceName`
  (instance property; the adapter also owns the connection),
  `TypeOrmEventPublicationRepository(dataSource: DataSource, dataSourceName = 'default')`
  (constructor takes both the connection and its name).

The asymmetry is deliberate and stable. Renaming one to match the
other would either:

- collapse `dataSourceName` → `dataSource` and clobber the connection
  field (breaks every existing typeorm consumer), or
- promote `dataSource` → `dataSourceName` everywhere (verbose and
  inconsistent with NestJS conventions like `@nestjs/typeorm`'s
  `getDataSourceToken(dataSource: string)` parameter naming).

Phase 14.11 removed the deprecated `instanceName` alias that was
retained for one phase boundary so consumers had time to migrate;
`dataSource` / `dataSourceName` is the canonical pair. A future
major-version cleanup may revisit the asymmetry; for now the two
names read naturally in their respective contexts and a single
sentence of doc (this section) prevents new-contributor confusion.

## Migration

The Phase 14 implementation roadmap
([docs/roadmap/README.md](../roadmap/README.md)) sequenced the work
across iterations 14.0–14.21:

- **14.0–14.2** — token utilities + `core` multi-adapter migration.
- **14.3 / 14.3.1 / 14.3.2** — outbox multi-adapter, decorator-driven
  per-DS handler registration (Categories A and B), multi-`forRoot`
  pivot ([ADR-019](019-outbox-multi-forroot-pattern.md)).
- **14.4–14.7** — TypeORM adapter, CQRS, examples migrations.
- **14.10** — `TransactionalModule.forRoot` aligned with
  multi-`forRoot`. Default `isGlobal` flipped to `true` to enable
  cross-call DI visibility.
- **14.11** — deprecated `instanceName` alias removed; `dataSource`
  / `dataSourceName` is canonical.
- **14.20** — transparent transactional repositories shipped (§ 9).
  `TypeOrmTransactionalModule.forFeature` renamed to `forRoot`;
  DataSource resolved from DI via `getDataSourceToken(name)`.
- **14.21** — `OutboxTypeOrmModule` reshape (§ 10) mirroring
  Phase 14.20.

The breaking-changes itemisation lives in
[`docs/migration/multi-adapter.md`](../migration/multi-adapter.md).
The end-to-end runnable demonstration of the final architecture is
[`examples/e-commerce-orders`](../../examples/e-commerce-orders/) —
three Postgres DataSources, per-DS outbox stacks, CQRS aggregates,
Kafka externalization. Smaller multi-DS examples
([`multi-datasource-basic`](../../examples/multi-datasource-basic/),
[`multi-datasource-outbox`](../../examples/multi-datasource-outbox/),
[`multi-datasource-cqrs`](../../examples/multi-datasource-cqrs/),
[`shared-database-modular-monolith`](../../examples/shared-database-modular-monolith/))
cover specific axes individually.

## Revision history

Phase-anchored. Each entry corresponds to a roadmap iteration in
[`docs/roadmap/README.md`](../roadmap/README.md).

- **Phase 14.0–14.3** — original ADR drafted with eight decision
  points.
- **Phase 14.2 scope refinement** — § 7 rewritten: single shared
  `AsyncLocalStorage` with disjoint Map keys provides the same
  disjoint-state guarantee as per-DS ALS instances would, without
  the cross-package migration cost. DD-023 carries the same
  revision.
- **Phase 14.3.2** — `OutboxModule.forRoot` array API replaced with
  multi-`forRoot`; full design rationale in ADR-019.
- **Phase 14.10** — same multi-`forRoot` pattern applied to
  `TransactionalModule.forRoot`. Default `isGlobal` flipped to
  `true` to enable cross-call DI visibility. The Phase 14.2 Q1.B
  `adapters: [...]` array form was removed.
- **Phase 14.11** — deprecated
  `TypeOrmTransactionalOptions.instanceName` alias removed;
  `dataSource` / `dataSourceName` is canonical.
- **Phase 14.20** — § 9 added: transparent transactional
  repositories. `TypeOrmTransactionalModule.forFeature` renamed to
  `forRoot`; DataSource resolved from DI. § 4 reshaped to reflect
  module-internal adapter construction.
- **Phase 14.21** — § 10 added: `OutboxTypeOrmModule` reshape
  mirroring Phase 14.20. Atomicity invariant verified by dedicated
  regression spec.
- **Phase 14.8f doc sweep** — addendum-driven running history
  collapsed into the Decision sections; § 3 / § 4 rewritten to
  reflect the final shipped form; this Revision history section
  added.
