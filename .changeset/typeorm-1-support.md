---
'@nestjs-transactional/typeorm': minor
'@nestjs-transactional/outbox-typeorm': minor
---

Support TypeORM 1.0 alongside 0.3.x.

The TypeORM peer-dependency range is widened to
`^0.3.0 || ^1.0.0`, covering the stable `0.3.x` and `1.x` lines.
TypeORM nightly / beta pre-release channels stay outside the
declared range; consumers who need them can install through
`pnpm.overrides`.

Internal compatibility: the patching layer reads the owning
`DataSource` from an `EntityManager` through a small helper
(`getEmDataSource`) that handles the 0.3.x → 1.0 rename
(`EntityManager.connection` → `EntityManager.dataSource`). All
other touchpoints (`QueryRunner`, schema-builder `Table` /
`TableIndex`, `MigrationInterface`, ORM decorators) are
behaviourally unchanged across the two majors. CI now runs the
full unit + integration matrix on both TypeORM versions.

`engines.node` for these two packages is bumped to `>=22.13.0`
to match TypeORM 1.0's minimum on the Node 22 line.
