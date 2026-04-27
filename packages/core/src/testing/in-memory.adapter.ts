import { randomUUID } from 'node:crypto';

import type { TransactionAdapter } from '../types/transaction-adapter';
import type { TransactionHandle } from '../types/transaction-handle';
import type { TransactionOptions } from '../types/transaction-options';

/**
 * Handle emitted by {@link InMemoryTransactionAdapter}. Extends
 * {@link TransactionHandle} with a mutable `operations` array that tests
 * can push into to simulate a unit of work and later assert on what the
 * adapter recorded.
 */
export interface InMemoryTransactionHandle extends TransactionHandle {
  /** Mutable scratch space for callers to record simulated operations. */
  readonly operations: unknown[];
}

/** A committed transaction record captured by {@link InMemoryTransactionAdapter}. */
export interface InMemoryCommittedTransaction {
  readonly id: string;
  readonly operations: unknown[];
  readonly options: TransactionOptions;
}

/** A rolled-back transaction record captured by {@link InMemoryTransactionAdapter}. */
export interface InMemoryRolledBackTransaction extends InMemoryCommittedTransaction {
  readonly error: unknown;
}

/** A savepoint lifecycle record captured by {@link InMemoryTransactionAdapter}. */
export interface InMemorySavepointRecord {
  readonly parentId: string;
  readonly savepointId: string;
}

/** A rolled-back savepoint record: {@link InMemorySavepointRecord} plus the error. */
export interface InMemoryRolledBackSavepointRecord extends InMemorySavepointRecord {
  readonly error: unknown;
}

/**
 * Adapter implementation intended for unit tests. Keeps the whole transaction
 * lifecycle in memory and exposes observation arrays (committed, rolled back,
 * savepoints created/released/rolled back) for assertions.
 *
 * Not suitable for production use — issues no real SQL, does no real
 * persistence, and offers no isolation guarantees. Test-only.
 *
 * Exported through `@nestjs-transactional/core/testing`, never through the
 * main entry point.
 */
export class InMemoryTransactionAdapter implements TransactionAdapter<InMemoryTransactionHandle> {
  readonly name = 'in-memory';

  /**
   * dataSource name this adapter is bound to (DD-021). Defaults to
   * `'default'`; override via the constructor to register multiple
   * in-memory adapters under distinct dataSource names in tests.
   */
  readonly dataSourceName: string;

  constructor(dataSourceName = 'default') {
    this.dataSourceName = dataSourceName;
  }

  committedTransactions: InMemoryCommittedTransaction[] = [];
  rolledBackTransactions: InMemoryRolledBackTransaction[] = [];
  savepointsCreated: InMemorySavepointRecord[] = [];
  savepointsReleased: InMemorySavepointRecord[] = [];
  savepointsRolledBack: InMemoryRolledBackSavepointRecord[] = [];

  async runInTransaction<T>(
    options: TransactionOptions,
    fn: (handle: InMemoryTransactionHandle) => Promise<T>,
  ): Promise<T> {
    const handle: InMemoryTransactionHandle = {
      id: randomUUID(),
      adapterName: this.name,
      operations: [],
    };

    try {
      const result = await fn(handle);
      this.committedTransactions.push({
        id: handle.id,
        operations: handle.operations,
        options,
      });
      return result;
    } catch (error) {
      this.rolledBackTransactions.push({
        id: handle.id,
        operations: handle.operations,
        options,
        error,
      });
      throw error;
    }
  }

  async runInSavepoint<T>(
    parent: InMemoryTransactionHandle,
    fn: (handle: InMemoryTransactionHandle) => Promise<T>,
  ): Promise<T> {
    const savepointId = randomUUID();
    this.savepointsCreated.push({ parentId: parent.id, savepointId });

    try {
      const result = await fn(parent);
      this.savepointsReleased.push({ parentId: parent.id, savepointId });
      return result;
    } catch (error) {
      this.savepointsRolledBack.push({ parentId: parent.id, savepointId, error });
      throw error;
    }
  }

  /**
   * Clear all observation arrays. Call between tests to avoid cross-test
   * leakage when reusing a single adapter instance.
   */
  reset(): void {
    this.committedTransactions = [];
    this.rolledBackTransactions = [];
    this.savepointsCreated = [];
    this.savepointsReleased = [];
    this.savepointsRolledBack = [];
  }
}
