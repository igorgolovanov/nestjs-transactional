import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { TransactionContext, type ActiveTransaction } from '../context/transaction.context';
import { IllegalTransactionStateError } from '../types/errors';
import { PropagationMode } from '../types/propagation';
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
 * Runtime that executes a callback inside a transaction, following the
 * requested {@link PropagationMode}. Exposes registration points for
 * before/after-commit and after-rollback hooks that the surrounding
 * transaction fires at the appropriate phase.
 *
 * All seven Spring-compatible propagation modes are supported:
 * `REQUIRED`, `REQUIRES_NEW`, `NESTED`, `SUPPORTS`, `NOT_SUPPORTED`,
 * `NEVER`, `MANDATORY`. See {@link TransactionManager.run} for the
 * per-mode behaviour.
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
   * Behaviour by propagation mode:
   * - `REQUIRED` (default): join the active transaction for this adapter
   *   instance if one exists; otherwise start a new transaction.
   * - `REQUIRES_NEW`: always start a new, independent transaction. If an
   *   outer transaction is active, its {@link ActiveTransaction} entry is
   *   suspended out of the context Map for the duration of the inner call
   *   and restored afterwards.
   * - `NESTED`: if an outer transaction is active, run inside a savepoint
   *   on that transaction (via {@link TransactionAdapter.runInSavepoint}).
   *   A savepoint rollback leaves the outer transaction intact. Lifecycle
   *   hooks registered inside a `NESTED` block attach to the outer
   *   transaction and fire on the outer commit/rollback. If no outer
   *   transaction is active, `NESTED` degrades to `REQUIRED`.
   * - `SUPPORTS`: run `fn` in the outer transaction if present; otherwise
   *   run `fn` directly with no transaction and no lifecycle hooks.
   * - `NOT_SUPPORTED`: suspend the outer transaction (remove its entry
   *   from the context Map) and run `fn` without transactional context.
   *   Restore on return. Note that the adapter-level connection/query
   *   runner is NOT actually suspended — this is a context-level opt-out.
   * - `NEVER`: throw {@link IllegalTransactionStateError} if an outer
   *   transaction is active; otherwise run `fn` directly.
   * - `MANDATORY`: throw {@link IllegalTransactionStateError} if no outer
   *   transaction is active; otherwise join it.
   *
   * Both inner and outer transactions share the surrounding
   * {@link TransactionContext} store — same `correlationId`, same Map —
   * only the Map slot at `instanceName` is swapped as propagation requires.
   */
  async run<T>(options: ExtendedTransactionOptions, fn: () => Promise<T>): Promise<T> {
    const adapterName = options.adapter ?? this.registry.getDefaultAdapterName();
    const instanceName = options.adapterInstance ?? this.registry.getDefaultInstanceName();
    const propagation = options.propagation ?? PropagationMode.REQUIRED;

    const existing = TransactionContext.getActiveTransaction(instanceName);

    switch (propagation) {
      case PropagationMode.REQUIRED: {
        if (existing !== undefined) {
          return fn();
        }
        const adapter = this.registry.get(adapterName, instanceName);
        return this.startNew(adapter, adapterName, instanceName, options, fn);
      }

      case PropagationMode.REQUIRES_NEW: {
        const adapter = this.registry.get(adapterName, instanceName);
        if (existing === undefined) {
          return this.startNew(adapter, adapterName, instanceName, options, fn);
        }
        TransactionContext.removeActiveTransaction(instanceName);
        try {
          return await this.startNew(adapter, adapterName, instanceName, options, fn);
        } finally {
          TransactionContext.setActiveTransaction(instanceName, existing);
        }
      }

      case PropagationMode.NESTED: {
        const adapter = this.registry.get(adapterName, instanceName);
        if (existing === undefined) {
          return this.startNew(adapter, adapterName, instanceName, options, fn);
        }
        return this.runNestedSavepoint(adapter, existing, options, fn);
      }

      case PropagationMode.SUPPORTS: {
        return fn();
      }

      case PropagationMode.NOT_SUPPORTED: {
        if (existing === undefined) {
          return fn();
        }
        TransactionContext.removeActiveTransaction(instanceName);
        try {
          return await fn();
        } finally {
          TransactionContext.setActiveTransaction(instanceName, existing);
        }
      }

      case PropagationMode.NEVER: {
        if (existing !== undefined) {
          throw new IllegalTransactionStateError(
            `Propagation NEVER cannot be invoked inside an active transaction ` +
              `(instance: '${instanceName}')`,
          );
        }
        return fn();
      }

      case PropagationMode.MANDATORY: {
        if (existing === undefined) {
          throw new IllegalTransactionStateError(
            `Propagation MANDATORY requires an active transaction, but none is ` +
              `active (instance: '${instanceName}')`,
          );
        }
        return fn();
      }
    }
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

  /**
   * Run `fn` inside a savepoint on `parent.handle`. Used by
   * {@link PropagationMode.NESTED} when there is an active outer transaction.
   *
   * The manager intentionally does NOT create a new
   * {@link ActiveTransaction} for the savepoint — hook registrations inside
   * `fn` fall through {@link currentTransaction} to the outer transaction,
   * which is the Spring-style semantic: nested events "promote" to the
   * enclosing transaction and fire when that transaction commits.
   *
   * Rollback semantics follow `shouldRollback`: errors that match the
   * rollback rules cause the adapter to roll back to the savepoint (the
   * outer transaction is unaffected); errors that do NOT match lead to a
   * savepoint release (commit-inside-savepoint) and the error is re-raised
   * to the caller after the release.
   */
  private async runNestedSavepoint<T>(
    adapter: TransactionAdapter,
    parent: ActiveTransaction,
    options: ExtendedTransactionOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const result = await adapter.runInSavepoint(
      parent.handle,
      async (): Promise<InternalResult<T>> => {
        try {
          const value = await fn();
          return { ok: true, value };
        } catch (err) {
          if (this.shouldRollback(err, options)) {
            throw err; // adapter rolls back to savepoint
          }
          return { ok: false, error: err };
        }
      },
    );

    if (result.ok) {
      return result.value;
    }
    throw result.error;
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
