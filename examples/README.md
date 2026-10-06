# Examples

Worked examples for `@nestjs-transactional/*`. Each folder is a runnable
NestJS application with a `pnpm start` visual demo, jest regression
tests, and a self-contained README.

Every outbox example delivers through
[`@nestjs/outbox`](https://docs.nestjs.com/reliability/outbox), with
`@nestjs-transactional/outbox` adding the message inside the transaction
`@Transactional` opened
([ADR-023](../docs/adr/023-delegate-delivery-to-nestjs-outbox.md)).

## Tier 1 — Foundational

The smallest possible illustrations of each core concept.

| Example                                        | Showcases                                                                                                                                         | Database                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| [`basic-transactional`](basic-transactional)   | `@Transactional()` on a plain service via `@InjectRepository` (transparent transactional repositories)                                            | TypeORM + sqljs (in-memory) |
| [`basic-typeorm-outbox`](basic-typeorm-outbox) | The outbox end to end: a message committed with the order, delivered to an `@OnOutboxMessage` handler, recorded in its inbox                      | Postgres (testcontainers)   |
| [`basic-cqrs`](basic-cqrs)                     | All three `@nestjs/cqrs` handler types — `@CommandHandler` + `@QueryHandler` (auto-wrapped readonly) + AFTER_COMMIT `@TransactionalEventsHandler` | None                        |

## Tier 2 — Multi-DataSource

- [`multi-datasource-basic`](multi-datasource-basic) —
  Billing + inventory DataSources, `@Transactional({ dataSource })`,
  no outbox/CQRS, cross-DS independence demonstrated.
- [`multi-datasource-cqrs`](multi-datasource-cqrs) —
  Two DataSources, CQRS handlers with dataSource option
  (per-dataSource handler routing for the cqrs in-memory
  dispatcher), per-DS transaction context.

The outbox lives in one DataSource. Publishing from a transaction on
another one is refused rather than written outside it, so there is no
multi-DataSource outbox example; `audit-logging` shows the shape that
does work, an outbox on one DataSource feeding a consumer on another.

## Tier 3 — Externalization

- [`externalization-kafka`](externalization-kafka) —
  Single DataSource + single Kafka broker. `@Externalized({ target,
routingKey, headers })` on the event class, `ClientProxyTransport`
  with `toKafkaPacket`, so the routing key is the Kafka key and the
  envelope is the value. A rejected emit keeps the message for a retry.
- [`externalization-multi-broker`](externalization-multi-broker) —
  Single DataSource, three brokers (Kafka topic + RabbitMQ queue +
  Redis pub/sub channel), routed per event by `@Externalized({ client })`
  and `externalizedRoute()`. Tests pin routing isolation and that one
  broker failing holds back only its own message.
- [`externalization-with-fallback`](externalization-with-fallback) —
  What a delivered message does and does not prove, and what happens
  when the broker is down: retries with backoff, dead-lettering after
  the last attempt, an operator requeue that keeps the message id. On
  the consumer side, `@nestjs/outbox`'s inbox driven through
  `@Transactional`.

## Tier 4 — Advanced patterns

- [`saga-pattern`](saga-pattern) — Choreographed 4-step saga (place →
  reserve → charge → ship) on a single Postgres DataSource, coordinated
  through the outbox. Each step is an `@OnOutboxMessage` handler that
  publishes its outcome in its own transaction. Compensation on both
  failure events; idempotency gates per step.
- [`audit-logging`](audit-logging) — Two physical Postgres DBs
  (business + audit). The outbox lives on the business DS; the
  `@OnOutboxMessage` consumer writes through
  `@Transactional({ dataSource: 'audit' })`, idempotent on the audit
  row's primary key. An audit-DS outage does not block business writes;
  the relay retries until it recovers.
- [`read-write-separation`](read-write-separation) —
  Two `TypeOrmModule.forRoot` registrations (`'default'` master +
  `'replica'`); only master gets the transactional adapter.
- [`testing-patterns`](testing-patterns) — Three test tiers against the
  same `WalletService` domain: unit with `InMemoryTransactionAdapter`,
  outbox unit with a recording `Outbox` (and why it cannot prove
  atomicity), integration with testcontainers Postgres and
  `relay.runOnce()`.

## Tier 5 — Production realism

- [`workflows-order-fulfilment`](workflows-order-fulfilment): one
  `@Transactional` command saves the order and, through the aggregate's
  `commit()`, starts a `@nestjs/workflows` workflow (`@StartOn`) and
  adds an `@nestjs/outbox` message, all or nothing. The workflow
  charges, reserves stock, marks the order paid, waits for a delivery
  signal sent from a transactional webhook, and compensates when a step
  fails for good. 6 integration tests on Postgres.
- [`e-commerce-orders`](e-commerce-orders) — Flagship. Three bounded
  contexts (Orders / Inventory / Billing) as three Postgres schemas on
  one DataSource, so every saga step publishes its outcome atomically.
  The saga starts from an aggregate (`@Externalized` to the `local`
  transport), runs over `@OnOutboxMessage` handlers, and ends with
  `OrderConfirmedEvent` on Kafka. CQRS command and query handlers plus
  a REST controller. 8 integration tests.
- [`async-config-from-environment`](async-config-from-environment) —
  `forRootAsync` with `ConfigModule` and Joi validation across
  `.env.{development,staging,production}` profiles. The relay tunables
  flow from the validated env into `@nestjs/outbox`'s
  `OutboxModule.forRootAsync`.

## How to run

From the monorepo root after `pnpm install`:

```bash
pnpm -C examples/<name> start                # visual demo
pnpm -C examples/<name> test                 # jest unit tests
pnpm -C examples/<name> test:integration     # testcontainers integration (where applicable)
```

`test:integration` exists in the examples that need Docker. The
externalization examples record the `ClientProxy` in their tests rather
than starting a broker; their `docker-compose.yml` is for the `pnpm start`
demos. What a real broker's acknowledgement means for an outbox message is
measured once, in the outbox package's broker suite (ADR-021).

The root `pnpm test` deliberately excludes `examples/*` to keep the
default dev loop fast — run the example tests directly when you change
example code.

## Conventions used by these examples

- **One module per example** — kept in `src/app.module.ts`, so the
  wiring is visible at a glance.
- **`@nestjs/outbox` configured as its documentation shows** —
  `OutboxModule` and a `PostgresOutboxStore` on `fromTypeOrm(dataSource)`.
  `TransactionalOutboxModule` adds the transactional publisher on top.
- **Tests drive the relay** — integration tests pass `relay: false` and
  call `OutboxRelay.runOnce()`, so delivery happens exactly when the test
  asks for it. `saga-pattern` and `e-commerce-orders` keep the relay
  running, because a saga is a chain of deliveries and the tests wait for
  its end state.
- **Stable `consumer` names** on `@OnOutboxMessage` — each keys the
  handler's inbox, so renaming one makes every past message look new.
- **`@nestjs/typeorm` standard wiring** — `@InjectRepository`,
  `getDataSourceToken`, `TypeOrmModule.forRoot/forFeature`. The
  transparent-repository patches make them dispatch through the active
  `@Transactional()` scope automatically.
- **`InMemoryTransactionAdapter` for non-DB examples** — exported via
  `@nestjs-transactional/core/testing`. Test-only adapter; production
  examples use real persistence.

## Picking the right starting point

- "I just want declarative transactions on a service method" →
  [`basic-transactional`](basic-transactional)
- "Show me the outbox with a real database, end-to-end" →
  [`basic-typeorm-outbox`](basic-typeorm-outbox)
- "I'm using `@nestjs/cqrs` and want to know how phase listeners
  cooperate with transactions" → [`basic-cqrs`](basic-cqrs)
- "I need multiple DataSources" →
  [`multi-datasource-basic`](multi-datasource-basic)
- "Events to Kafka" → [`externalization-kafka`](externalization-kafka)
- "What happens when the broker is down" →
  [`externalization-with-fallback`](externalization-with-fallback)
- "End-to-end realistic application — saga + Kafka + CQRS + REST" →
  [`e-commerce-orders`](e-commerce-orders)
- "`forRootAsync` + `ConfigService` + per-environment .env
  profiles" →
  [`async-config-from-environment`](async-config-from-environment)
- "Multi-step business process with compensation" →
  [`saga-pattern`](saga-pattern) on outbox handlers, or
  [`workflows-order-fulfilment`](workflows-order-fulfilment) as a
  durable workflow
- "`@nestjs/workflows`, `@nestjs/outbox` and CQRS in one transaction" →
  [`workflows-order-fulfilment`](workflows-order-fulfilment)
- "Cross-DataSource audit trail through the outbox" →
  [`audit-logging`](audit-logging)
- "Master/replica DataSource setup" →
  [`read-write-separation`](read-write-separation)
- "Test scaffolding skeleton — unit, outbox unit, integration" →
  [`testing-patterns`](testing-patterns)

## Further reading

- [Architecture documents](../docs/architecture/)
- [Architecture Decision Records](../docs/adr/)
- [Implementation roadmap](../docs/roadmap/README.md) (per-phase
  history) and [per-phase status retrospectives](../docs/status/).
- [Conventions discovered during implementation](../docs/status/conventions.md).
