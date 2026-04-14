# DD-022: Inject decorators accept a dataSource parameter

**Context**: Token-based DI works (`@Inject(getTransactionManagerToken('billing'))`
is valid), but it is verbose and not discoverable in IDE autocomplete.
Users coming from `@nestjs/typeorm` expect an
`@InjectXxx(dataSource?)` shorthand.

**Alternatives considered**:
- Token-based `@Inject` only. Rejected: poor discoverability,
  inconsistent with `@nestjs/typeorm`'s `@InjectRepository` /
  `@InjectDataSource`.
- Mandatory dataSource argument. Rejected: breaks single-adapter
  ergonomics — every consumer would have to type `'default'`.

**Decision**: Provide
`@InjectTransactionManager(dataSource?)`,
`@InjectOutboxPublisher(dataSource?)`,
`@InjectEventPublicationRepository(dataSource?)`,
etc. Default argument is `'default'`. They are thin wrappers over
`@Inject(token)` where `token = getXxxToken(dataSource)`.

**Consequences**: Idiomatic NestJS DX. Single-adapter consumers
write `@InjectTransactionManager()` exactly as they would have
written `@Inject(TransactionManager)` before — no token strings in
user code.
