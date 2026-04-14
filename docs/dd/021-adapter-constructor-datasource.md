# DD-021: Adapter constructor accepts dataSource name

**Context**: With multi-adapter support, a package must know which
specific dataSource its adapter is bound to. The current shape
(adapter as singleton, dataSource looked up via registry) does not
generalise to "two TypeORM dataSources, two adapter instances".

**Alternatives considered**:
- Adapter as singleton, dataSource passed per call. Rejected: forces
  every caller to know the dataSource, defeats the encapsulation
  purpose of having an adapter at all.
- Adapter accepts a `DataSource` instance directly (the actual
  TypeORM `DataSource` object). Rejected: couples the adapter
  constructor to TypeORM's class shape, breaks the cross-ORM
  contract — Prisma's "dataSource" is not the same shape as
  TypeORM's.

**Decision**: Adapter constructor accepts a string dataSource name.
`new TransactionalTypeOrmAdapter('billing')`. The adapter resolves
the actual ORM-specific resource (the TypeORM `DataSource` instance,
the Prisma client, etc.) internally — typically via DI tokens
derived from the dataSource name.

**Consequences**: Multiple adapter instances of the same class are
first-class. Adapter packages must follow a consistent constructor
contract `(dataSource: string)`, making it easier to author new
adapters. See [ADR-018](../adr/018-multi-adapter-architecture.md).
