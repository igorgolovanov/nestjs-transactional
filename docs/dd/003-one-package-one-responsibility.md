# DD-003: One package, one responsibility

**Alternatives**:
- A monolithic `@nestjs-transactional` package with optional parts
- Core + a single "integrations" package

**Choice**: three separate packages. Users install only what they need:
- Transactions without CQRS → core + typeorm
- CQRS without TypeORM (e.g. Prisma, once that adapter exists) →
  core + cqrs + prisma

**Trade-off**: more release overhead (multiple package versions), but a
cleaner architecture and smaller bundle size.
