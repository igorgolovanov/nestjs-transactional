import { randomUUID } from 'node:crypto';

import { type ActiveTransaction, TransactionContext } from './transaction.context';

function makeActiveTx(adapterInstanceName: string): ActiveTransaction {
  return {
    handle: { id: randomUUID(), adapterName: 'in-memory' },
    adapterName: 'in-memory',
    adapterInstanceName,
    options: {},
    startedAt: new Date(),
    afterCommitHooks: [],
    afterRollbackHooks: [],
    beforeCommitHooks: [],
    correlationId: 'corr-1',
  };
}

describe('TransactionContext.getActiveTransactionByDataSource', () => {
  it('returns the entry whose adapterInstanceName matches the dataSource', async () => {
    await TransactionContext.run('corr-1', async () => {
      const tx = makeActiveTx('billing');
      TransactionContext.setActiveTransaction('billing', tx);

      expect(TransactionContext.getActiveTransactionByDataSource('billing')).toBe(tx);
    });
  });

  it('looks up by dataSource name regardless of the Map key format the manager wrote under', async () => {
    // Simulate the composite-key write path used by TransactionManager
    // (`${adapterName}:${instanceName}`). The dataSource-name lookup
    // must still find the entry because the match is on
    // `tx.adapterInstanceName`, not on the Map key string.
    await TransactionContext.run('corr-1', async () => {
      const tx = makeActiveTx('inventory');
      TransactionContext.setActiveTransaction('typeorm:inventory', tx);

      expect(TransactionContext.getActiveTransactionByDataSource('inventory')).toBe(tx);
    });
  });

  it('returns undefined when no transaction matches the dataSource', async () => {
    await TransactionContext.run('corr-1', async () => {
      TransactionContext.setActiveTransaction('billing', makeActiveTx('billing'));
      expect(TransactionContext.getActiveTransactionByDataSource('audit')).toBeUndefined();
    });
  });

  it('returns undefined outside any run() scope', () => {
    expect(TransactionContext.getActiveTransactionByDataSource('billing')).toBeUndefined();
  });
});
