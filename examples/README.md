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
| [`basic-cqrs`](basic-cqrs) | All three `@nestjs/cqrs` handler types — `@CommandHandler` + `@QueryHandler` (auto-wrapped readonly) + AFTER_COMMIT `@TransactionalEventsHandler` | None |

## Tier 2 — Multi-DataSource (Phase 14.8b, in progress)

- [`multi-datasource-basic`](multi-datasource-basic) **— shipped.**
  Billing + inventory DataSources, `@Transactional({ dataSource })`,
  no outbox/CQRS, cross-DS independence demonstrated.
- [`multi-datasource-outbox`](multi-datasource-outbox) **— shipped.**
  Two DataSources each with own outbox, per-DS event types via
  `forFeature({ dataSource })`, decorator-driven handler registration
  (Phase 14.3.1), real Postgres per-DS `event_publication` tables.
- [`multi-datasource-cqrs`](multi-datasource-cqrs) **— shipped.**
  Two DataSources, CQRS handlers с dataSource option (Phase 14.3.1
  Category B), per-DS transaction context.
- `shared-database-modular-monolith` *(planned)* — same Postgres,
  different schemas / logical separation, Spring Modulith-style
  architecture.

## Tier 3 — Externalization (Phase 14.8c, planned)

- `externalization-kafka` — single DataSource, outbox +
  outbox-microservices с Kafka, `@Externalized` events.
- `externalization-multi-broker` — single DataSource, multiple
  brokers (Kafka + RabbitMQ + Redis), per-event
  `@Externalized({ client })` routing.
- `externalization-multi-datasource` — multi-DS + multi-broker,
  combined complexity, real production scenario.
- `externalization-with-fallback` — externalization с ADR-016
  reliability concerns, documented limitations exposed, fallback
  patterns.

## Tier 4 — Advanced patterns (Phase 14.8d, planned)

- `saga-pattern` — long-running transaction across multiple steps,
  compensating actions on failure, outbox for inter-step coordination.
- `audit-logging` — `@Transactional` на business operations,
  separate audit dataSource, audit events через outbox в audit-DS.
- `read-write-separation` — master/replica DataSource setup,
  `@Transactional` для writes, read queries from replica.
- `testing-patterns` — comprehensive test setup demonstration:
  mock adapter usage, testcontainers integration tests, in-memory
  outbox for fast tests.

## Tier 5 — Production realism (Phase 14.8e, planned)

- `e-commerce-orders` — realistic domain (Order, Product, Customer),
  multi-DS, outbox, externalization к Kafka, CQRS for read/write.
  Complete realistic application end-to-end.
- `async-config-from-environment` — `forRootAsync` с `ConfigService`,
  environment-based DataSource configuration, dev/staging/prod variants.
- `graceful-shutdown` — outbox processor draining, in-flight
  transaction completion, connection cleanup, lifecycle hooks.

## Existing examples (slated for retirement or absorption during Phase 14.8f)

These predate the tier framework and overlap with planned Tier 2+
examples. They remain runnable for now; the Phase 14.8f doc sweep
will retire / refactor / absorb them based on the realised Tier
2–5 coverage:

- [`cqrs-full-stack`](cqrs-full-stack) — TypeORM + `AggregateRoot`
  + multiple phase listeners + `Query` handler. Persistence side
  may be partially absorbed into `basic-typeorm-outbox` follow-ups
  or `e-commerce-orders` (Phase 14.8e).
- [`outbox-full-stack`](outbox-full-stack) — TypeORM + outbox +
  CQRS + worker, real Postgres via docker-compose. Likely
  superseded by `e-commerce-orders` (Phase 14.8e) which targets
  the same complete-realistic-application audience.

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
- "I need multiple DataSources" →
  [`multi-datasource-basic`](multi-datasource-basic)
- "Full TypeORM + CQRS + multiple phases" →
  [`cqrs-full-stack`](cqrs-full-stack)
- "Full TypeORM + outbox + CQRS + worker + Postgres" →
  [`outbox-full-stack`](outbox-full-stack); `e-commerce-orders`
  (Phase 14.8e) when shipped

## Further reading

- [Architecture documents](../docs/architecture/)
- [Architecture Decision Records](../docs/adr/)
- [Migrating to outbox guide](../docs/guides/migrating-to-outbox.md)
- The repo root [`CLAUDE.md`](../CLAUDE.md) has the full state record
  (Phase 14 history, conventions, decisions).
