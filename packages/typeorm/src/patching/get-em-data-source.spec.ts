import type { DataSource, EntityManager } from 'typeorm';

import { getEmDataSource } from './get-em-data-source';

describe('getEmDataSource', () => {
  const sentinel = { name: 'ds' } as unknown as DataSource;

  it('returns `dataSource` when the EntityManager exposes the 1.0+ field name', () => {
    const em = { dataSource: sentinel } as unknown as EntityManager;

    expect(getEmDataSource(em)).toBe(sentinel);
  });

  it('returns `connection` when the EntityManager exposes the 0.3.x field name', () => {
    const em = { connection: sentinel } as unknown as EntityManager;

    expect(getEmDataSource(em)).toBe(sentinel);
  });

  it('throws when neither field is present', () => {
    const em = {} as unknown as EntityManager;

    expect(() => getEmDataSource(em)).toThrow(/Unsupported TypeORM version/);
  });
});
