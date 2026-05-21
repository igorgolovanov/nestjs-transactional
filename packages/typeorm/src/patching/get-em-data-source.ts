import type { DataSource, EntityManager } from 'typeorm';

/**
 * Read the owning {@link DataSource} from an {@link EntityManager}
 * across TypeORM versions.
 *
 * TypeORM 0.3.x exposes `EntityManager.connection: DataSource`.
 * TypeORM 1.0 renamed it to `EntityManager.dataSource: DataSource`
 * and removed the legacy name. The two field names never coexist
 * on the same `EntityManager` instance, so checking both keeps the
 * patching layer compatible with both peer ranges without a runtime
 * version check.
 */
export function getEmDataSource(em: EntityManager): DataSource {
  const shape = em as unknown as {
    dataSource?: DataSource;
    connection?: DataSource;
  };
  const ds = shape.dataSource ?? shape.connection;
  if (ds === undefined) {
    throw new Error(
      'EntityManager exposes neither `dataSource` nor `connection`. ' +
        'Unsupported TypeORM version.',
    );
  }
  return ds;
}
