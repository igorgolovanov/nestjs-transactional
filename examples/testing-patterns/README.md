# testing-patterns

Three test tiers for code that uses `@nestjs-transactional`,
demonstrated against the same tiny `WalletService` domain. The
example is **test-first**: the source files exist to give the
tests something to exercise; the assertions are what the example
is really showing.

## When to use this example

- You are starting a new project that uses this framework and
  want a copy-paste skeleton for the test setup.
- You have an existing project and want to see what each
  test-side utility (`InMemoryTransactionAdapter`,
  `InMemoryEventPublicationRepository`, `PublishedEvents`,
  `AssertablePublishedEvents`, testcontainers Postgres) is
  actually for and when to reach for it.
- You're deciding whether a particular invariant belongs to a
  unit test or an integration test.

## The three tiers

### Tier 1 — unit tests with `InMemoryTransactionAdapter`

`test/wallet.service.spec.ts`. No database, no Docker, no outbox
delivery. Sub-millisecond per case. Use this tier for:

- Branch coverage on domain logic.
- "Does this method open a transaction?" assertions — the adapter
  records every transaction into `committedTransactions` /
  `rolledBackTransactions` arrays.
- Mocking the repository as a Jest mock or a hand-rolled fake.

The wiring is one line:

```ts
TransactionalModule.forRoot({ adapter: new InMemoryTransactionAdapter() })
```

The repository is provided as a Jest mock under the
`WALLET_REPOSITORY` token — no TypeORM module is imported at all.

### Tier 2 — outbox unit tests with `InMemoryEventPublicationRepository`

`test/wallet-outbox.spec.ts`. Still no database, but now the
outbox machinery is wired. Verifies what the service **published**
without actually delivering anything. Two assertion styles:

- `PublishedEvents` — Spring-Modulith-style fluent view, returns
  raw arrays for ad-hoc Jest matchers.
- `AssertablePublishedEvents` — fluent assertions that throw
  `PublishedEventsAssertionError` on mismatch and chain
  naturally.

The wiring trick: `OutboxModule.forRoot({})` **without** an
explicit `repository` option defaults to
`InMemoryEventPublicationRepository`. There is no swap-in step;
just leave the option off in test code.

A subtle property worth exercising: the in-memory repository
registers an `afterRollback` hook for every `createAll`. A
publication created inside a rolled-back transaction **disappears**
from `PublishedEvents.all()` after the rollback runs. The third
test in the file pins this — same visibility guarantee a real
DB-backed outbox gives.

### Tier 3 — integration tests with testcontainers Postgres

`test/wallet.integration.spec.ts`. Real Postgres, real outbox
tables, real worker. Slower (a few seconds per suite once the
image is cached) but exercises:

- Row-level isolation between transactions.
- The worker poll loop and status transitions
  (`PUBLISHED → COMPLETED`).
- The actual TypeORM Repository implementation injected under
  `WALLET_REPOSITORY` (the production `TypeOrmWalletRepository`).
- The outbox-routed `@IntegrationEventsHandler` listener under
  realistic asynchronous timing — `waitFor(...)` because the worker
  delivers in its own poll cycle, not synchronously at commit.

Each integration test catches significantly more regressions than
its unit-tier counterpart. Keep a healthy ratio of both: the unit
tiers for fast iteration, the integration tier for end-to-end
invariants.

## Prerequisites

- For unit tiers (Tier 1 and Tier 2): nothing beyond `pnpm install`.
- For Tier 3 integration: **Docker Desktop / Colima / Rancher
  Desktop running.** testcontainers pulls `postgres:16-alpine`
  on first run (~30 MB).

## Run

```bash
pnpm install                                       # from monorepo root

# Tier 1 + Tier 2 (no Docker required, fast):
pnpm -C examples/testing-patterns test

# Tier 3 (Docker required):
pnpm -C examples/testing-patterns test:integration
```

## What's NOT covered here

- **Externalization tests with a mocked broker `ClientProxy`.** That
  pattern is documented in
  [`externalization-with-fallback`](../externalization-with-fallback)
  and the other Tier 3 externalization examples — the mock returns
  `of(undefined)` from `emit()` so the framework's ADR-016 silent-
  success behaviour is observable in the test.
- **Multi-DataSource testing.** See
  [`multi-datasource-outbox`](../multi-datasource-outbox) for the
  testcontainers + multi-DB pattern (one container, two databases).
- **Saga / compensation tests.** See [`saga-pattern`](../saga-pattern).

## Common pitfalls

- **Testing the framework instead of your code.** Resist the urge
  to assert that `OutboxEventPublisher` writes to
  `event_publication` correctly — that is covered by the
  framework's own tests. Assert what *your* domain emits and how
  *your* listeners react.
- **Snapshotting publication rows.** The `id`, `publicationDate`,
  `completionDate` columns are non-deterministic. Use
  `PublishedEvents.ofType(...).matching(...)` on the deserialized
  payload instead of `toMatchSnapshot` on the raw row.
- **Forgetting `OutboxModule.resetForTesting()` in `beforeEach`.**
  The module's `forFeature` aggregations live in module-static
  state. Without `resetForTesting`, a prior test's event class
  registrations leak into the next test. The wallet-outbox spec
  does this correctly.
- **Sharing testcontainers Postgres across test files.** The
  containers are isolated per `describe` block in this example
  for clarity. In a larger suite you can share via Jest's
  `globalSetup` to amortise the startup cost; trade off against
  the cross-test isolation that comes for free with one
  container per file.

## Related examples

- [`basic-cqrs`](../basic-cqrs) — the foundational unit-only
  example using `InMemoryTransactionAdapter` for a CQRS-style
  domain.
- [`basic-typeorm-outbox`](../basic-typeorm-outbox) — production-shape
  outbox wiring; a useful reference for the integration test setup.
- [`saga-pattern`](../saga-pattern) — domain-rich integration
  tests with multi-step coordination.

## Further reading

- [DD-019 — single-unit atomicity invariant](../../docs/dd/019-single-unit-atomicity.md)
- [DD-024 — smart-facade `OutboxEventPublisher`](../../docs/dd/024-smart-facade-outbox-publisher.md)
- [`packages/core/src/testing/in-memory.adapter.ts`](../../packages/core/src/testing/in-memory.adapter.ts)
- [`packages/outbox/src/testing/published-events.ts`](../../packages/outbox/src/testing/published-events.ts)
- [`packages/outbox/src/testing/assertable-published-events.ts`](../../packages/outbox/src/testing/assertable-published-events.ts)
