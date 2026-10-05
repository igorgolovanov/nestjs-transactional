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
  test-side tool (`InMemoryTransactionAdapter`, a recording
  `Outbox`, testcontainers Postgres with `OutboxRelay.runOnce()`)
  is actually for and when to reach for it.
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

### Tier 2 — outbox unit tests with a recording `Outbox`

`test/wallet-outbox.spec.ts`. Still no database. The real
`OutboxEventPublisher` runs inside real `@Transactional` transactions on
the in-memory adapter, against a stand-in for `@nestjs/outbox`'s `Outbox`
that records each `add()`. That verifies what the service **hands the
outbox**: which messages, on which topic, with which payload and headers.

The wiring is a global module that provides `Outbox`, plus
`TransactionalOutboxModule.forRoot({ transactionResolver: (active) =>
active.handle })`: the in-memory adapter's handle is not a TypeORM
`EntityManager`, so the resolver hands the handle itself to the stand-in.

What this tier deliberately does **not** assert is atomicity. Whether a
message rolls back with the wallet row is decided by the database
transaction the store writes through, so a stand-in can only pretend.
That assertion lives in Tier 3, where there is a database to decide it.

### Tier 3 — integration tests with testcontainers Postgres

`test/wallet.integration.spec.ts`. Real Postgres, the real
`PostgresOutboxStore`, the real relay. Slower (a few seconds per suite
once the image is cached) but exercises:

- The message committing and rolling back **with** the wallet row.
- Delivery to the `@OnOutboxMessage` listener (`WalletProjection`).
- The actual TypeORM Repository implementation injected under
  `WALLET_REPOSITORY` (the production `TypeOrmWalletRepository`).

The module is built with `relay: false`, and each test calls
`OutboxRelay.runOnce()` to deliver: no polling, no `waitFor`, no timing
to race. This is the testing pattern `@nestjs/outbox` documents.

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

- **Externalization tests with a recorded broker `ClientProxy`.** See
  [`externalization-with-fallback`](../externalization-with-fallback)
  and the other Tier 3 externalization examples: the stand-in returns
  `of(undefined)` from `emit()` for a delivered message and throws for a
  failed one, which drives both outcomes without a broker container.
- **Saga / compensation tests.** See [`saga-pattern`](../saga-pattern).

## Common pitfalls

- **Testing the framework instead of your code.** Resist the urge to
  assert how `@nestjs/outbox` stores or claims messages; its own
  contract suites cover that. Assert what *your* domain emits and how
  *your* listeners react.
- **Snapshotting outbox rows.** Message ids, sequence numbers and
  timestamps are non-deterministic. Assert on topic and payload instead.
- **Waiting on a background relay in tests.** A relay that polls on its
  own makes every assertion a race against the poll interval. Turn it
  off and call `runOnce()`.
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

- [DD-028 — the outbox bridge contract](../../docs/dd/028-outbox-bridge-contract.md)
- [`packages/core/src/testing/in-memory.adapter.ts`](../../packages/core/src/testing/in-memory.adapter.ts)
- [`@nestjs/outbox` testing guide](https://docs.nestjs.com/reliability/outbox#testing)
