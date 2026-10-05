import * as cqrs from './index.js';

describe('deprecated 2.x names', () => {
  it('are the same values as their Transactional-first replacements', () => {
    expect(cqrs.CqrsTransactionalModule).toBe(cqrs.TransactionalCqrsModule);
    expect(cqrs.CqrsTransactionalBootstrap).toBe(cqrs.TransactionalCqrsBootstrap);
    expect(cqrs.CQRS_TRANSACTIONAL_OPTIONS).toBe(cqrs.TRANSACTIONAL_CQRS_OPTIONS);
  });

  it('keep the module usable through the old name', () => {
    const options: cqrs.CqrsTransactionalOptions = { eventsDataSource: 'default' };
    const module = cqrs.CqrsTransactionalModule.forRoot(options);

    expect(module.module).toBe(cqrs.TransactionalCqrsModule);
  });
});
