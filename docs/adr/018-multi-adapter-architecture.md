# ADR-018: Multi-adapter architecture — dataSource-name-keyed registration

- **Status**: Accepted
- **Date**: 2026-04-27
- **Related**:
  - ADR-005 (method wrapping strategy)
  - ADR-007 (outbox architecture: core + persistence split)
  - DD-005 (multi-DataSource as a first-class feature — already partially
    implemented in `packages/typeorm`)
  - DD-020 (multi-adapter through dataSource-name identifier)
  - DD-021 (adapter constructor accepts dataSource name)
  - DD-022 (inject decorators with dataSource parameter)
  - DD-023 (independent transaction contexts per dataSource)
  - DD-024 (smart `OutboxEventPublisher` facade)

> **Note (Phase 14.2 scope refinement, 2026-04-27):** Point 7
> ("Independent transaction contexts") originally read "each
> dataSource gets its own `AsyncLocalStorage` instance". During
> Phase 14.2 implementation planning we discovered the existing
> core architecture already provides the same *semantic* guarantee
> through a single shared `AsyncLocalStorage` whose store carries a
> `Map` keyed by dataSource name — cross-dataSource enrolment is
> structurally impossible because the keys are disjoint. Migrating
> to literal per-dataSource ALS instances would have cascaded
> through every consumer of `TransactionContext`'s static API
> (typeorm helpers, CQRS dispatcher, outbox publisher, ~487 tests)
> for no functional benefit. Section 7 below has been rewritten to
> describe what we ship; CLAUDE.md DD-023 carries the same revision.

> **Note (Phase 14.3.2 module-registration shape, 2026-04-27):**
> Point 3 ("Per-dataSource provider registration") shows
> `TransactionalModule.forRoot` taking a single `{ adapter,
> dataSource }` per call and is silent on the analogous
> `OutboxModule.forRoot` shape. Phase 14.3 originally shipped an
> array API (`OutboxModule.forRoot({ dataSources: [...] })`) that
> deviated from the per-call pattern. Phase 14.3.2 reworked
> `OutboxModule` to the multi-`forRoot` shape: each call registers
> one dataSource's outbox stack; cross-call coordination of
> singletons (smart facade, processing bundle, listener scanner)
> happens through static class storage modelled on
> `@nestjs/typeorm`'s `EntitiesMetadataStorage`. Full design
> rationale and mechanism in
> [ADR-019](./019-outbox-multi-forroot-pattern.md). Phase 14.10
> applies the same pattern to `TransactionalModule.forRoot`,
> closing the asymmetry that Phase 14.2 Q1.B (single
> `forRoot` call with an `adapters: [...]` array) introduced
> relative to the `OutboxModule` rework.

> **Note (Phase 14.10 + 14.11 cleanup, 2026-04-27):** The
> Phase 14.3.2 forward-reference above has now landed.
>
> **Phase 14.10** rewrote `TransactionalModule.forRoot` to the
> multi-`forRoot` shape. The `adapters: [...]` array form (Phase
> 14.2 Q1.B) is removed entirely; each adapter-bearing call
> registers exactly one dataSource. Static class storage
> (`TransactionalModule.registrations` Map +
> `infrastructureRegistered` flag) coordinates singletons across
> calls — the same mechanism Phase 14.3.2 introduced for
> `OutboxModule` per ADR-019. The default `isGlobal` flips from
> `false` to `true` to match `OutboxModule` and unblock multi-
> call cross-DI visibility (without the flip, sibling
> `DynamicModule`s cannot see the first call's
> `TransactionManager` / `AdapterRegistry`). The
> infrastructure-only shorthand `TransactionalModule.forRoot({})`
> (no adapter) is preserved — `TypeOrmTransactionalModule.forFeature`
> remains a valid adapter-source path that registers
> imperatively into the AdapterRegistry.
>
> **Phase 14.11** removed the deprecated
> `TypeOrmTransactionalOptions.instanceName` alias introduced in
> Phase 14.4. The canonical `dataSourceName` field remains;
> dual-read logic is gone. The alias was retained for one phase
> boundary so consumers had time to migrate; pre-release
> cleanup eliminates the carry-over.
>
> Cumulative effect: a single coherent multi-adapter API
> surface across `core`, `typeorm`, and `outbox` packages, all
> using per-dataSource per-call registration. Item 1 in the
> "Migration to multi-adapter" section of CLAUDE.md describes
> the `forRoot` signature change in past tense; item 8 reflects
> Phase 14.11's alias removal.

## Context

The current architecture supports a single transactional adapter
*instance* per process. Multiple `DataSource`s under the same TypeORM
adapter are supported via the `instanceName` field
(see DD-005 and `getCurrentEntityManager(instanceName, fallback)`),
but there is no story for:

1. **Multiple `DataSource`s of the same ORM that need fully independent
   outbox stacks** — e.g. `billing` events committed against the billing
   DB and `inventory` events against the inventory DB, with separate
   `event_publication` tables and separate workers.
2. **Different ORMs running in the same process** — e.g. TypeORM for
   the main relational data, Prisma for an audit store, Mongoose for
   user-profile documents. Each needs its own transactional contract
   and its own outbox.
3. **Module-per-database boundaries in a modular monolith** — each
   bounded-context module owns its DB, its outbox, and its event
   publications. Cross-module integration is via durable events, not
   shared transactions.

Real-world cases that motivate this:

- Modular monoliths where each module ships with its own schema (and
  potentially its own ORM choice).
- Migration scenarios where a team is moving piecewise from ORM A to
  ORM B and needs both alive in the same process for some weeks.
- Reporting / analytics / audit stores that intentionally live in a
  different storage technology than the OLTP main store.

The existing single-adapter design conflates "the adapter" with "the
DI scope" — there is one `TransactionManager`, one `AdapterRegistry`,
one `OutboxModule`, one `EventPublicationRepository`. To extend to
the cases above without breaking single-adapter users, we need a
naming contract that distinguishes adapter *instances* and a DI
contract that lets users inject the right one.

## Decision

Implement multi-adapter through the seven points below. They form a
cohesive design — accepting any one in isolation does not make sense.

### 1. dataSource name as primary identifier

A string `dataSource` name keys every adapter instance, every
transactional context, every outbox stack. Default `'default'`
preserves the current single-adapter ergonomics — users who never
register a non-default name see no change.

The dataSource name is what users *think* in (it's the name of their
DB, not "the TypeORM adapter for the billing DB"). It also generalises
cleanly across ORMs: a `'billing'` dataSource might be TypeORM today
and Prisma tomorrow without renaming.

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

### 3. Per-dataSource provider registration

Each `TransactionalModule.forRoot({ adapter, dataSource })` registers
a *complete* set of providers under dataSource-derived tokens. Two
calls produce two disjoint sets — no cross-talk.

```ts
@Module({
  imports: [
    TransactionalModule.forRoot({
      adapter: new TransactionalTypeOrmAdapter('billing'),
      dataSource: 'billing',
    }),
    TransactionalModule.forRoot({
      adapter: new TransactionalTypeOrmAdapter('inventory'),
      dataSource: 'inventory',
    }),
  ],
})
export class AppModule {}
```

The "default" registration (no `dataSource`) keeps the current ergonomic
shape and serves the single-adapter case unchanged.

### 4. Adapter constructor accepts dataSource name

```ts
const adapter = new TransactionalTypeOrmAdapter('billing');
```

The adapter encapsulates ORM-specific transaction control *and* its
binding to a specific dataSource. Multiple instances of the same
adapter class are first-class — there is no "global TypeORM state"
anywhere in the design.

This also clarifies the package boundary: `packages/typeorm` knows
which TypeORM `DataSource` it is bound to; it does NOT inspect a
registry to figure that out.

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

`@InjectTransactionManager()` (no argument) defaults to
`'default'` — single-adapter consumers are unaffected. Mirrors
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
registered under `'inventory'`. Crossing a dataSource boundary inside a
single async call stack creates a *separate* `Map` entry; there is no
automatic enrolment of the second manager into the first manager's
transaction.

The keying-not-multiple-ALS shape is deliberate. Spinning up a
dedicated `AsyncLocalStorage` instance per dataSource would deliver
the same guarantee (disjoint state) at the cost of cascading the
static→instance migration of `TransactionContext` through every
consumer (adapter helpers, CQRS dispatcher, outbox publisher) — for no
behavioural improvement.

This is deliberate. Distributed transactions across heterogeneous
stores would force XA or 2PC into the design — see "Alternatives
considered" below for why we reject that.

The user-facing implication: cross-dataSource consistency is an
*application-level* concern. The recommended pattern is "write to
dataSource A, publish a durable event, consume the event in
dataSource B" — i.e. the outbox stack is the consistency boundary
between dataSources. The single-unit atomicity contract from DD-019
applies to each dataSource independently.

### 8. Smart `OutboxEventPublisher` facade detects the active dataSource

A facade wrapper around the per-dataSource publishers detects which
dataSource has an active transaction in the current async context and
routes the event accordingly:

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

This keeps single-adapter call sites unchanged (the facade resolves to
the only registered publisher) while making multi-adapter publishing
ergonomic — no per-call `@Inject` plumbing.

If no transaction is active and no explicit dataSource is given, the
facade falls back to `'default'` and (per the single-adapter rules)
fails fast if `'default'` is not registered.

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

Rejected. "Whichever dataSource has an active transaction" is fine for
*outbox publishing inside a `@Transactional` body* (point 8 above —
that's the smart-facade path), but it breaks down for boundary cases:

- Outside any transaction (which dataSource does the event belong to?)
- Two dataSources active at once via nested `@Transactional` calls
  with different `dataSource` options
- Application bootstrap code, tests, scripts

For non-publishing APIs (`@InjectTransactionManager`,
`@Transactional({ dataSource })`), explicit-better-than-implicit wins
unambiguously. Auto-detection there would create confusing failures
("why did this run on `billing`?") that are hard to debug.

### Configuration via DI only (no decorator support)

Rejected. The current decorator-based API
(`@Transactional`, `@InjectRepository`-style decorators) is idiomatic
NestJS, ships well, and matches what users already know from the
NestJS ecosystem. Forcing the multi-adapter API to be DI-only would
introduce a parallel pattern — strictly worse usability for the
single-adapter case (the vast majority of users).

The decorators in points 5 and 6 *are* DI under the hood. They just
add a thin discoverable surface on top.

## Consequences

### Positive

- Production-grade multi-database support — the patterns motivating
  this ADR (modular monolith, audit-store split, ORM migration) all
  have first-class support.
- Multi-ORM combinations work without internal special-casing — adapter
  packages share a contract; new adapters slot in.
- Idiomatic NestJS — the `getXxxToken(dataSource)` /
  `@InjectXxx(dataSource)` pattern matches `@nestjs/typeorm` and
  `@nestjs/mongoose`, so users coming from that ecosystem don't learn
  a new vocabulary.
- Single-adapter users are unaffected — the default `'default'`
  threading is transparent.
- Outbox stacks naturally partition along dataSource lines — no
  contention on a single `event_publication` table when multiple
  bounded-context modules emit events.

### Negative

- Significant API refactoring across every package
  (`core`, `typeorm`, `cqrs`, `outbox`, `outbox-typeorm`,
  `outbox-microservices`) — see "Migration to multi-adapter" in
  CLAUDE.md for the file-level impact list.
- Verbose configuration for multi-database setups —
  `TransactionalModule.forRoot()` repeated per dataSource,
  `OutboxModule.forRoot({ dataSource })` repeated per dataSource,
  etc. Mitigation: a `TransactionalModule.forFeatures([...])` shorthand
  could be added later if the verbosity proves painful in real apps.
  Not in scope for Phase 14.
- Cross-dataSource transactions explicitly unsupported — users
  expecting Spring's `@Transactional` behavior across multiple
  datasources will need to rethink in terms of events. Documented
  prominently in the migration guide.
- Token-naming convention is now a stable public API — once shipped,
  changing `getTransactionManagerToken` is a breaking change for
  anyone who hand-built tokens around the same string.

### Neutral

- The convention `'{Component}{DataSource}'` (PascalCase, dataSource
  capitalised) becomes the standard pattern for any future ORM
  adapter package. Consistency is the win; the cost is documenting it
  once.
- Adapter packages must follow a consistent constructor contract
  (`new TransactionalXxxAdapter(dataSource: string)`), making it
  easier to author new adapters.

## Adapter pattern conventions

Confirmed during Phase 14.4 audit and codified here as guidance for
future ORM adapters (`@nestjs-transactional/prisma`,
`@nestjs-transactional/mongoose`, etc.):

- **Adapters receive the concrete native connection directly.**
  TypeORM's adapter takes a `DataSource` instance (or a thunk
  resolving to one); a Prisma adapter would take a `PrismaClient`;
  a Mongoose adapter would take a `Connection`. The user already
  has these — usually instantiated from their own `forRoot` config
  via `@nestjs/typeorm`, `nestjs-prisma`, etc. — and passes the
  instance through. The adapter does NOT lazily resolve the
  connection via DI tokens (`getDataSourceToken`, etc.); the
  resolution path is the user's, kept transparent.
- **The adapter is created at module-config time**, bound to the
  connection at construction. `TypeOrmTransactionalModule.forFeature`
  builds a `TypeOrmTransactionAdapter(dataSource, dataSourceName)` in
  its provider factory; future ORM modules follow the same shape
  (`PrismaTransactionalModule.forFeature({ prisma, dataSourceName })`,
  `MongooseTransactionalModule.forFeature({ connection, dataSourceName })`).
- **The dataSource identifier is a string flowing through every
  consumer.** The adapter exposes it as `dataSourceName`; the user
  passes it via `@Transactional({ dataSource })`,
  `getCurrentEntityManager(dataSource)`, and the per-DS inject
  decorators. The same string must round-trip cleanly across
  decorator → manager → registry → adapter → helper.

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
  `TypeOrmTransactionalOptions.dataSourceName` (the options object
  also has `dataSource: DataSource | factory` for the connection).

The asymmetry is deliberate and stable. Renaming one to match the
other would either:
- collapse `dataSourceName` → `dataSource` and clobber the
  connection field (breaks every existing typeorm consumer), or
- promote `dataSource` → `dataSourceName` everywhere (verbose and
  inconsistent with NestJS conventions like `@nestjs/typeorm`'s
  `getDataSourceToken(dataSource: string)` parameter naming).

A future major-version cleanup may revisit; for now the two names
read naturally in their respective contexts and a single sentence
of doc (this section) prevents new-contributor confusion.

## Migration

The Phase 14 implementation roadmap (CLAUDE.md) sequences the
migration as 14.0–14.9: token utilities → core multi-adapter →
outbox multi-adapter → adapter package migrations → CQRS migration →
examples + docs → final verification.

Breaking changes are itemised in CLAUDE.md's "Migration to
multi-adapter" section. Packages are not yet published, so accepting
the breakage now is materially cheaper than introducing a parallel
single-adapter API and supporting both forever.
