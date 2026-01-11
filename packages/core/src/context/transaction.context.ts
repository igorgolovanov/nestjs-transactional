import { AsyncLocalStorage } from 'node:async_hooks';

import { IllegalTransactionStateError } from '../types/errors';
import type { TransactionHandle } from '../types/transaction-handle';
import type { TransactionOptions } from '../types/transaction-options';

/**
 * A single transaction currently live on the async context. Adapters register
 * one of these under their `adapterInstanceName` when they begin a transaction
 * and remove it when the transaction ends. Hooks registered on this object
 * are fired by the manager during commit / rollback.
 */
export interface ActiveTransaction {
  /** Adapter-specific opaque handle — cast by the adapter's own helpers. */
  readonly handle: TransactionHandle;

  /** Adapter type name (e.g. `'typeorm'`) — mirrors `handle.adapterName`. */
  readonly adapterName: string;

  /** Adapter instance name (e.g. `'primary'`, `'billing'`) under which it was registered. */
  readonly adapterInstanceName: string;

  /** Options the manager handed to the adapter when beginning this transaction. */
  readonly options: TransactionOptions;

  /** Wall-clock moment the transaction began, for observability. */
  readonly startedAt: Date;

  /** Hooks executed just before the adapter issues COMMIT. A throwing hook rolls the transaction back. */
  readonly afterCommitHooks: (() => Promise<void>)[];

  /** Hooks executed after a successful COMMIT. */
  readonly afterRollbackHooks: ((error: unknown) => Promise<void>)[];

  /** Hooks executed after a ROLLBACK; receive the error that caused the rollback. */
  readonly beforeCommitHooks: (() => Promise<void>)[];

  /** Correlation id inherited from the enclosing {@link TransactionContext} scope. */
  readonly correlationId: string;
}

/**
 * Per-scope state that lives on the async context. Created on the outermost
 * {@link TransactionContext.run} call and reused by all nested ones, so that
 * a single logical unit of work owns a single correlation id and a single
 * registry of active transactions across adapters.
 */
export interface TransactionContextStore {
  /** Active transactions keyed by `adapterInstanceName`. */
  readonly activeTransactions: Map<string, ActiveTransaction>;

  /** Stable correlation id for the whole scope — set by the outermost run(). */
  readonly correlationId: string;

  /** Wall-clock moment the scope began. */
  readonly startedAt: Date;
}

const als = new AsyncLocalStorage<TransactionContextStore>();

/**
 * Thin façade over `AsyncLocalStorage` that carries the active
 * {@link TransactionContextStore} across async boundaries. This is the
 * foundation of the module — every decorator, interceptor, and adapter helper
 * ultimately asks this class whether a transaction is live on the current
 * async chain.
 */
export class TransactionContext {
  /**
   * Run `fn` inside a transaction context scope.
   *
   * - If there is no active store on the current async chain, a new store is
   *   created (empty active-transaction map, `correlationId`, current time)
   *   and installed for the duration of `fn`.
   * - If there is already an active store, `fn` is executed directly — the
   *   existing store is reused. The `correlationId` argument is ignored in
   *   that case; the outermost scope owns the correlation id.
   *
   * Propagates the value resolved (or error thrown) by `fn`.
   */
  static run<T>(correlationId: string, fn: () => Promise<T>): Promise<T> {
    if (als.getStore() !== undefined) {
      return fn();
    }
    const store: TransactionContextStore = {
      activeTransactions: new Map<string, ActiveTransaction>(),
      correlationId,
      startedAt: new Date(),
    };
    return als.run(store, fn);
  }

  /** Return the active store, or `undefined` if called outside any run() scope. */
  static getStore(): TransactionContextStore | undefined {
    return als.getStore();
  }

  /** Return the active transaction registered under `adapterInstanceName`, or `undefined`. */
  static getActiveTransaction(adapterInstanceName: string): ActiveTransaction | undefined {
    return als.getStore()?.activeTransactions.get(adapterInstanceName);
  }

  /**
   * Register `tx` under `adapterInstanceName` on the current store.
   *
   * @throws {IllegalTransactionStateError} If called outside of a run() scope.
   *   Adapters must not attempt to register a transaction without a
   *   surrounding context — doing so would leak the transaction state.
   */
  static setActiveTransaction(adapterInstanceName: string, tx: ActiveTransaction): void {
    const store = als.getStore();
    if (store === undefined) {
      throw new IllegalTransactionStateError(
        'Cannot set active transaction outside of TransactionContext.run()',
      );
    }
    store.activeTransactions.set(adapterInstanceName, tx);
  }

  /**
   * Remove the active transaction registered under `adapterInstanceName`.
   * Idempotent: a no-op when no store is active or the instance is not
   * registered, so that adapter cleanup paths can call it unconditionally.
   */
  static removeActiveTransaction(adapterInstanceName: string): void {
    als.getStore()?.activeTransactions.delete(adapterInstanceName);
  }
}
