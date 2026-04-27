import { randomUUID } from 'node:crypto';

import { TransactionContextView } from './transaction-context-view';
import {
  type ActiveTransaction,
  TransactionContext,
} from './transaction.context';

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

describe('TransactionContextView', () => {
  it('returns the active transaction for the bound dataSource', async () => {
    const view = new TransactionContextView('billing');

    await TransactionContext.run('corr-1', async () => {
      const tx = makeActiveTx('billing');
      TransactionContext.setActiveTransaction('billing', tx);

      expect(view.getActiveTransaction()).toBe(tx);
      expect(view.hasActiveTransaction()).toBe(true);
    });
  });

  it('returns undefined when no transaction is active for the bound dataSource', async () => {
    const view = new TransactionContextView('inventory');

    await TransactionContext.run('corr-1', async () => {
      // billing has a tx; inventory does not
      TransactionContext.setActiveTransaction('billing', makeActiveTx('billing'));

      expect(view.getActiveTransaction()).toBeUndefined();
      expect(view.hasActiveTransaction()).toBe(false);
    });
  });

  it('returns undefined outside any TransactionContext.run() scope', () => {
    const view = new TransactionContextView('billing');
    expect(view.getActiveTransaction()).toBeUndefined();
    expect(view.hasActiveTransaction()).toBe(false);
  });

  it('exposes its bound dataSource as a readable property', () => {
    const view = new TransactionContextView('audit');
    expect(view.dataSource).toBe('audit');
  });

  it('isolates lookups across simultaneous dataSources within the same scope', async () => {
    const billingView = new TransactionContextView('billing');
    const inventoryView = new TransactionContextView('inventory');

    await TransactionContext.run('corr-1', async () => {
      const billingTx = makeActiveTx('billing');
      const inventoryTx = makeActiveTx('inventory');
      TransactionContext.setActiveTransaction('billing', billingTx);
      TransactionContext.setActiveTransaction('inventory', inventoryTx);

      expect(billingView.getActiveTransaction()).toBe(billingTx);
      expect(inventoryView.getActiveTransaction()).toBe(inventoryTx);
      expect(billingView.getActiveTransaction()).not.toBe(inventoryView.getActiveTransaction());
    });
  });
});
