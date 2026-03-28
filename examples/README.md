# Examples

Worked examples for `@nestjs-transactional/*`. Each folder is a runnable
NestJS application with a `pnpm start` visual demo, jest regression
tests, and a self-contained README.

## Tier 1 — Foundational (Phase 14.8a)

The smallest possible illustrations of each core concept. Pick the one
matching your need; the four cover the canonical entry points.

| Example | Showcases | Database |
|---|---|---|
| [`basic-transactional`](basic-transactional) | `@Transactional()` on a plain service via `@InjectRepository` (Phase 14.20 transparent repositories) | TypeORM + sqljs (in-memory) |
| [`basic-outbox`](basic-outbox) | `@OutboxEventsHandler` + `OutboxEventPublisher.publish` with the in-memory test adapter | None |
| [`basic-typeorm-outbox`](basic-typeorm-outbox) | Production-shape outbox with Postgres, atomicity verified by testcontainers | Postgres (testcontainers) |
| [`basic-cqrs`](basic-cqrs) | `@CommandHandler` + AFTER_COMMIT `@TransactionalEventsHandler` (in-memory, phase-aware) | None |

## Tier 2+ — Existing examples (under per-tier renovation)

These examples ship today but are slated for a refresh in the
following sub-phases:

- [`multi-datasource`](multi-datasource) — multiple `DataSource`s
  wired through `TransactionalModule.forRoot` per-DS calls. *Phase
  14.8b refresh: cross-DB transaction isolation, durable cross-DB
  integration via outbox, Spring Modulith-style modular monolith.*
- [`cqrs-full-stack`](cqrs-full-stack) — TypeORM + `AggregateRoot` +
  multiple phase listeners + `Query` handler. *Phase 14.8d refresh.*
- [`outbox-full-stack`](outbox-full-stack) — TypeORM + outbox + CQRS
  + worker, real Postgres via docker-compose. *Phase 14.8e refresh.*

## How to run

From the monorepo root after `pnpm install`:

```bash
pnpm -C examples/<name> start                # visual demo
pnpm -C examples/<name> test                 # jest unit/integration tests
pnpm -C examples/<name> test:integration     # testcontainers integration (where applicable)
```

Each example honours these scripts; `test:integration` only exists in
examples that require Docker (currently `basic-typeorm-outbox` and
`outbox-full-stack`).

The root `pnpm test` deliberately excludes `examples/*` to keep the
default dev loop fast — run the example tests directly when you change
example code.

## Conventions used by these examples

- **One module per example** — kept in `src/app.module.ts`. Real
  applications use NestJS's `forFeature` pattern; the examples
  deliberately collapse to one module so the wiring is visible at a
  glance.
- **Stable `@OutboxEventsHandler` ids** — `id: 'Module.action'` so the
  examples model the production discipline (renaming a class without
  a stable id invalidates pending publication rows).
- **`@nestjs/typeorm` standard wiring** — `@InjectRepository`,
  `getDataSourceToken`, `TypeOrmModule.forRoot/forFeature`. The
  Phase 14.20 transparent-repository patches make them dispatch
  through the active `@Transactional()` scope automatically.
- **No `getCurrentEntityManager()` in service code** unless an
  explicit escape hatch is needed (Phase 14.20 known limitations:
  `@InjectEntityManager() em.save()` direct call, `BaseEntity`
  static methods).
- **`InMemoryTransactionAdapter` for non-DB examples** — exported via
  `@nestjs-transactional/core/testing`. Test-only adapter; production
  examples use real persistence.

## Picking the right starting point

- "I just want declarative transactions on a service method" →
  [`basic-transactional`](basic-transactional)
- "I want durable AFTER_COMMIT delivery, no DB yet" →
  [`basic-outbox`](basic-outbox)
- "Show me the outbox with a real database, end-to-end" →
  [`basic-typeorm-outbox`](basic-typeorm-outbox)
- "I'm using `@nestjs/cqrs` and want to know how phase listeners
  cooperate with transactions" → [`basic-cqrs`](basic-cqrs)
- "I need multiple DataSources" → [`multi-datasource`](multi-datasource)
- "Full TypeORM + CQRS + multiple phases" →
  [`cqrs-full-stack`](cqrs-full-stack)
- "Full TypeORM + outbox + CQRS + worker + Postgres" →
  [`outbox-full-stack`](outbox-full-stack)

## Further reading

- [Architecture documents](../docs/architecture/)
- [Architecture Decision Records](../docs/adr/)
- [Migrating to outbox guide](../docs/guides/migrating-to-outbox.md)
- The repo root [`CLAUDE.md`](../CLAUDE.md) has the full state record
  (Phase 14 history, conventions, decisions).
