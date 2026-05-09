# DD-010: Split outbox into core + persistence packages

**Context**: Need to support multiple persistence backends (TypeORM now,
Prisma / MikroORM / MongoDB in future).

**Alternatives considered**:
- Single `@nestjs-transactional/outbox` package with TypeORM baked in.
  Rejected: forces users to adopt TypeORM.
- `@nestjs-transactional/outbox-{backend}` monolithic packages (one per
  backend). Rejected: duplicates core logic.

**Decision**: `outbox` with an `EventPublicationRepository` SPI plus
separate `outbox-{backend}` packages implementing the SPI. Follows the
existing pattern (core + typeorm).

**Consequences**: Clean separation, easy to add backends. Users must
install two packages, slightly more setup.

> See also: [ADR-007](../adr/007-outbox-architecture.md) for the
> ADR-form record of this split.
