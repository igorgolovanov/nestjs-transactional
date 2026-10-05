# Monorepo Structure

Top-down map of the workspace. Sub-trees that have ballooned past
the point of fitting in a single tree (the example library
particularly) link out to their own indexes rather than enumerate
every leaf here.

```
nestjs-transactional-monorepo/
├── packages/
│   ├── core/                              # @nestjs-transactional/core
│   │   ├── src/
│   │   │   ├── types/                     # public types and interfaces
│   │   │   ├── context/                   # TransactionContext (AsyncLocalStorage)
│   │   │   ├── manager/                   # TransactionManager, AdapterRegistry
│   │   │   ├── decorators/                # @Transactional, aliases, @InjectXxx
│   │   │   ├── interceptor/               # NestJS interceptor
│   │   │   ├── module/                    # TransactionalModule (forRoot/forRootAsync)
│   │   │   ├── observability/             # Observer interface, hooks
│   │   │   ├── testing/                   # InMemoryTransactionAdapter (via /testing)
│   │   │   └── index.ts                   # public API
│   │   ├── test/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── README.md
│   │
│   ├── typeorm/                           # @nestjs-transactional/typeorm
│   │   ├── src/
│   │   │   ├── adapter/                   # TypeOrmTransactionAdapter
│   │   │   ├── helpers/                   # getCurrentEntityManager, isInTransaction
│   │   │   ├── patches/                   # transparent-repository prototype patches
│   │   │   ├── module/                    # TransactionalTypeOrmModule
│   │   │   └── index.ts
│   │   └── test/                          # unit + integration (testcontainers)
│   │
│   ├── cqrs/                              # @nestjs-transactional/cqrs
│   │   ├── src/
│   │   │   ├── decorators/                # @TransactionalEventsHandler, @IntegrationEventsHandler
│   │   │   ├── interfaces/                # ITransactionalEventHandler, IIntegrationEventHandler
│   │   │   ├── types/                     # TransactionPhase
│   │   │   ├── event-dispatcher/          # TransactionalEventDispatcher
│   │   │   ├── event-publisher/           # TransactionalEventBusPublisher, CqrsEventBusBinding
│   │   │   ├── handlers/                  # CqrsHandlerWrapper, scanners
│   │   │   ├── module/                    # TransactionalCqrsModule
│   │   │   └── index.ts
│   │
│   └── outbox/                            # @nestjs-transactional/outbox: bridge onto @nestjs/outbox
│       ├── src/
│       │   ├── externalization/           # @Externalized and its target → client routes
│       │   ├── publisher/                 # OutboxEventPublisher: outbox.add() in the ambient transaction
│       │   ├── routing/                   # externalizedRoute(), toKafkaPacket()
│       │   └── module/                    # TransactionalOutboxModule, tokens
│       └── test/
│           ├── integration/               # PostgreSQL suite (TypeORM matrix)
│           └── brokers/                   # Kafka + RabbitMQ acknowledgement suite (ADR-021)
│
├── examples/                              # Tier 1–5 example library — see examples/README.md
│   ├── README.md                          # top-level index
│   ├── basic-transactional/               # Tier 1
│   ├── basic-typeorm-outbox/              # Tier 1
│   ├── basic-cqrs/                        # Tier 1
│   ├── multi-datasource-basic/            # Tier 2
│   ├── multi-datasource-cqrs/             # Tier 2
│   ├── externalization-kafka/             # Tier 3
│   ├── externalization-multi-broker/      # Tier 3
│   ├── externalization-with-fallback/     # Tier 3
│   ├── saga-pattern/                      # Tier 4
│   ├── audit-logging/                     # Tier 4
│   ├── read-write-separation/             # Tier 4
│   ├── testing-patterns/                  # Tier 4
│   ├── e-commerce-orders/                 # Tier 5 (flagship)
│   └── async-config-from-environment/     # Tier 5
│
├── docs/
│   ├── adr/                               # Architecture Decision Records (NNN-slug.md)
│   ├── dd/                                # Design Decisions (NNN-slug.md)
│   ├── architecture/                      # principles, parity, monorepo, architecture deep-dives
│   ├── roadmap/                           # Implementation roadmap, per-era files
│   ├── status/                            # Per-phase retrospectives
│   ├── migration/                         # Migration guides for breaking changes
│   ├── guides/                            # User-facing guides (e.g. migrating-to-outbox.md)
│   ├── sessions/                          # Session handoff notes
│   └── known-limitations.md
│
├── README.md                              # public-facing repo entry point
├── CONTRIBUTING.md                        # contributor guide
├── package.json                           # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json                     # shared TS settings
├── tsconfig.json                          # solution-style root (project references)
├── jest.config.base.js
├── eslint.config.mjs                      # flat config (ESLint 10)
├── .prettierrc
└── .gitignore
```
