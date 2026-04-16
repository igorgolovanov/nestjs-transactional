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
│   │   │   ├── patches/                   # Phase 14.20 prototype patches
│   │   │   ├── module/                    # TypeOrmTransactionalModule
│   │   │   └── index.ts
│   │   └── test/                          # unit + integration (testcontainers)
│   │
│   ├── cqrs/                              # @nestjs-transactional/cqrs
│   │   ├── src/
│   │   │   ├── decorators/                # @TransactionalEventsHandler, @IntegrationEventsHandler
│   │   │   ├── interfaces/                # ITransactionalEventHandler, IIntegrationEventHandler
│   │   │   ├── types/                     # TransactionPhase
│   │   │   ├── event-dispatcher/          # TransactionalEventDispatcher
│   │   │   ├── event-publisher/           # TransactionalEventPublisher + HybridEventPublisher
│   │   │   ├── handlers/                  # CqrsHandlerWrapper, scanners
│   │   │   ├── module/                    # CqrsTransactionalModule
│   │   │   └── index.ts
│   │
│   ├── outbox/                            # @nestjs-transactional/outbox (alpha)
│   │   ├── src/
│   │   │   ├── types/                     # EventPublication, lifecycle states, errors
│   │   │   ├── serialization/             # EventSerializer SPI, JsonEventSerializer, EventTypeRegistry
│   │   │   ├── repository/                # EventPublicationRepository SPI
│   │   │   ├── registry/                  # EventPublicationRegistry, listener registry, scanner
│   │   │   ├── decorators/                # @OutboxEventsHandler, inject decorators
│   │   │   ├── dispatcher/                # OutboxEventPublisher facade, EventPublicationProcessor
│   │   │   ├── externalization/           # EventExternalizer SPI, @Externalized, registry
│   │   │   ├── recovery/                  # StartupRecoveryService, StalenessMonitor
│   │   │   ├── api/                       # FailedEventPublications, IncompleteEventPublications, CompletedEventPublications
│   │   │   ├── module/                    # OutboxModule, OutboxProcessingModule
│   │   │   └── testing/                   # InMemory repo, PublishedEvents, AssertablePublishedEvents (via /testing)
│   │
│   ├── outbox-typeorm/                    # @nestjs-transactional/outbox-typeorm (alpha)
│   │   ├── src/
│   │   │   ├── entity/                    # EventPublicationEntity, EventPublicationArchiveEntity
│   │   │   ├── repository/                # TypeOrmEventPublicationRepository
│   │   │   ├── migrations/                # Shipped migration
│   │   │   ├── schema/                    # SchemaInitializer (development-only)
│   │   │   └── module/                    # OutboxTypeOrmModule
│   │
│   └── outbox-microservices/              # @nestjs-transactional/outbox-microservices (alpha)
│       ├── src/
│       │   ├── externalizer/              # MicroservicesEventExternalizer
│       │   ├── module/                    # OutboxMicroservicesModule (forRoot/forRootAsync)
│       │   └── types/                     # OutboxMicroservicesOptions, tokens
│
├── examples/                              # Tier 1–5 example library — see examples/README.md
│   ├── README.md                          # top-level index
│   ├── basic-transactional/
│   ├── basic-outbox/
│   ├── basic-typeorm-outbox/
│   ├── basic-cqrs/
│   ├── multi-datasource-basic/
│   ├── multi-datasource-outbox/
│   ├── multi-datasource-cqrs/
│   ├── shared-database-modular-monolith/
│   ├── externalization-kafka/
│   ├── externalization-multi-broker/
│   ├── externalization-multi-datasource/
│   ├── externalization-with-fallback/
│   ├── cqrs-full-stack/                   # pre-tier; absorption pending Phase 14.8f
│   └── outbox-full-stack/                 # pre-tier; absorption pending Phase 14.8f
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
├── .eslintrc.js
├── .prettierrc
└── .gitignore
```
