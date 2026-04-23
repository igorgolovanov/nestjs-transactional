import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { TransactionContext, type ActiveTransaction } from '../context/transaction.context';
import { IllegalTransactionStateError } from '../types/errors';
import type { TransactionAdapter } from '../types/transaction-adapter';
import type { ExtendedTransactionOptions } from '../types/transaction-options';

import { ADAPTER_REGISTRY, AdapterRegistry } from './adapter.registry';

/**
 * Unified lifecycle hook shape used internally by {@link TransactionManager.runHooks}.
 * Accepts an optional `error` so that the same runner can drive both
 * commit-phase and rollback-phase hooks.
 */
type TransactionHook = (error?: unknown) => Promise<void>;

/**
 * Discriminated union used to thread a business error through the adapter's
 * `runInTransaction` without forcing a rollback. When the manager decides
 * that a thrown error should NOT roll the transaction back (via
 * {@link TransactionManager.shouldRollback}), the inner callback returns
 * `{ ok: false, error }` — the adapter commits successfully, then the
 * manager re-raises the error to the caller outside the adapter call.
 */
type InternalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Runtime that executes a callback inside a transaction, joining an active
 * one when one already exists (propagation `REQUIRED`, the default Spring
 * behaviour). Also exposes registration points for before/after commit and
 * after rollback hooks that the surrounding transaction fires at the
 * appropriate phase.
 *
 * Only `REQUIRED` propagation is supported in this iteration. Other modes
 * (`REQUIRES_NEW`, `NESTED`, etc.) are ignored for now and will be added in
 * subsequent iterations.
 */
@Injectable()
export class TransactionManager {
  private readonly logger = new Logger(TransactionManager.name);

  constructor(
    @Inject(ADAPTER_REGISTRY)
    private readonly registry: AdapterRegistry,
  ) {}

  /**
   * Execute `fn` inside a transaction managed by the adapter resolved from
   * `options` (or defaults from {@link AdapterRegistry}).
   *
   * Behaviour (propagation `REQUIRED`):
   * - If a transaction is already active on the current async context for
   *   the selected adapter instance, `fn` joins that transaction and runs
   *   directly. No new adapter call, no additional hook lifecycle.
   * - Otherwise, a new transaction is started via
   *   `adapter.runInTransaction`; commit hooks fire on success, rollback
   *   hooks fire on failure, both routed through {@link runHooks}.
   */
  async run<T>(options: ExtendedTransactionOptions, fn: () => Promise<T>): Promise<T> {
    const adapterName = options.adapter ?? this.registry.getDefaultAdapterName();
    const instanceName = options.adapterInstance ?? this.registry.getDefaultInstanceName();

    const existing = TransactionContext.getActiveTransaction(instanceName);
    if (existing !== undefined) {
      return fn();
    }

    const adapter = this.registry.get(adapterName, instanceName);
    return this.startNew(adapter, adapterName, instanceName, options, fn);
  }

  /**
   * Register a hook to fire after the current transaction commits
   * successfully. Attaches to the first active transaction on the current
   * async context — sufficient for single-adapter setups. Hook errors are
   * swallowed with a warning and do not reject `run()`.
   *
   * @throws {IllegalTransactionStateError} If called outside an active transaction.
   */
  registerAfterCommit(hook: () => Promise<void>): void {
    this.currentTransaction().afterCommitHooks.push(hook);
  }

  /**
   * Register a hook to fire after the current transaction rolls back. The
   * hook receives the error that caused the rollback.
   *
   * @throws {IllegalTransactionStateError} If called outside an active transaction.
   */
  registerAfterRollback(hook: (error: unknown) => Promise<void>): void {
    this.currentTransaction().afterRollbackHooks.push(hook);
  }

  /**
   * Register a hook to fire just before the transaction commits. A throwing
   * hook triggers the adapter's rollback — the transaction does not commit.
   *
   * @throws {IllegalTransactionStateError} If called outside an active transaction.
   */
  registerBeforeCommit(hook: () => Promise<void>): void {
    this.currentTransaction().beforeCommitHooks.push(hook);
  }

  private async startNew<T>(
    adapter: TransactionAdapter,
    adapterName: string,
    instanceName: string,
    options: ExtendedTransactionOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const outerStore = TransactionContext.getStore();
    const correlationId = outerStore?.correlationId ?? randomUUID();

    let activeTx: ActiveTransaction | undefined;

    const body = async (): Promise<T> => {
      let result: InternalResult<T>;
      try {
        result = await adapter.runInTransaction(
          options,
          async (handle): Promise<InternalResult<T>> => {
            activeTx = {
              handle,
              adapterName,
              adapterInstanceName: instanceName,
              options,
              startedAt: new Date(),
              afterCommitHooks: [],
              afterRollbackHooks: [],
              beforeCommitHooks: [],
              correlationId,
            };
            TransactionContext.setActiveTransaction(instanceName, activeTx);

            try {
              try {
                const innerValue = await fn();
                // Before-commit hooks run inside the adapter callback so
                // that a throwing hook still triggers the adapter's
                // rollback path.
                for (const hook of activeTx.beforeCommitHooks) {
                  await hook();
                }
                return { ok: true, value: innerValue };
              } catch (err) {
                if (this.shouldRollback(err, options)) {
                  throw err; // let the adapter roll back
                }
                // Commit despite the error — the manager will re-raise it
                // to the caller after the adapter's commit succeeds.
                return { ok: false, error: err };
              }
            } finally {
              TransactionContext.removeActiveTransaction(instanceName);
            }
          },
        );
      } catch (rollbackError) {
        if (activeTx !== undefined) {
          await this.runHooks(activeTx.afterRollbackHooks, rollbackError);
        }
        throw rollbackError;
      }

      // Adapter has committed. Fire afterCommit hooks regardless of whether
      // we are about to re-raise a business error — the database state is
      // what the hook subscribers care about, and it has been persisted.
      if (activeTx !== undefined) {
        await this.runHooks(activeTx.afterCommitHooks);
      }

      if (result.ok) {
        return result.value;
      }
      throw result.error;
    };

    if (outerStore === undefined) {
      return TransactionContext.run(correlationId, body);
    }
    return body();
  }

  private currentTransaction(): ActiveTransaction {
    const store = TransactionContext.getStore();
    if (store === undefined) {
      throw new IllegalTransactionStateError(
        'Cannot register a transactional hook outside of TransactionManager.run()',
      );
    }
    for (const tx of store.activeTransactions.values()) {
      return tx;
    }
    throw new IllegalTransactionStateError(
      'Cannot register a transactional hook: no active transaction on the current context',
    );
  }

  /**
   * Spring-style decision on whether a thrown error should trigger rollback:
   *
   * 1. If `noRollbackFor` is set and matches, commit anyway (precedence).
   * 2. Else if `rollbackFor` is set, roll back only when the error matches
   *    an entry — a non-match commits (explicit allow-list semantics).
   * 3. Else (no rules set), any error triggers rollback — the default
   *    transactional behaviour.
   */
  private shouldRollback(error: unknown, options: ExtendedTransactionOptions): boolean {
    const { noRollbackFor, rollbackFor } = options;

    if (noRollbackFor !== undefined && noRollbackFor.length > 0) {
      if (noRollbackFor.some((cls) => error instanceof cls)) {
        return false;
      }
    }

    if (rollbackFor !== undefined && rollbackFor.length > 0) {
      return rollbackFor.some((cls) => error instanceof cls);
    }

    return true;
  }

  private async runHooks(hooks: readonly TransactionHook[], error?: unknown): Promise<void> {
    for (const hook of hooks) {
      try {
        await hook(error);
      } catch (hookError) {
        this.logger.warn(
          `Transaction lifecycle hook failed: ${String(hookError)}`,
          hookError instanceof Error ? hookError.stack : undefined,
        );
      }
    }
  }
}
