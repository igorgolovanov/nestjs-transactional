import * as typeorm from '../../src/index.js';

describe('deprecated 2.x names', () => {
  it('are the same values as their Transactional-first replacements', () => {
    expect(typeorm.TypeOrmTransactionalModule).toBe(typeorm.TransactionalTypeOrmModule);
  });

  it('keep the module usable through the old name', () => {
    const options: typeorm.TypeOrmTransactionalOptions = { dataSource: 'default' };
    const module = typeorm.TypeOrmTransactionalModule.forRoot(options);

    expect(module.module).toBe(typeorm.TransactionalTypeOrmModule);
  });
});
