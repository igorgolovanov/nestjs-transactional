import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { TransactionContext, type ActiveTransaction } from '../context/transaction.context.js';
import {
  TRANSACTION_OBSERVERS,
  type TransactionCommitContext,
  type TransactionObserver,
  type TransactionRollbackContext,
  type TransactionStartContext,
} from '../observability/transaction-observer.js';
import { IllegalTransactionStateError } from '../types/errors.js';
import { PropagationMode } from '../types/propagation.js';
import type { TransactionAdapter } from '../types/transaction-adapter.js';
import type { ExtendedTransactionOptions } from '../types/transaction-options.js';

import { ADAPTER_REGISTRY, AdapterRegistry } from './adapter.registry.js';

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
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

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
  private readonly pending = new WeakMap<ActiveTransaction, Set<Promise<unknown>>>();
  /** Errors a transaction was rolled back for: the only ones a retry may follow. */
  private readonly rolledBack = new WeakSet<object>();

  constructor(
    @Inject(ADAPTER_REGISTRY)
    private readonly registry: AdapterRegistry,
    @Optional()
    @Inject(TRANSACTION_OBSERVERS)
    private readonly observers: readonly TransactionObserver[] = [],
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
    // dataSource takes precedence over adapter/adapterInstance (DD-020).
    // Resolved up front so the rest of run() works in a single shape.
    const { adapterName, instanceName } = this.resolveAdapterIdentifiers(options);
    const propagation = options.propagation ?? PropagationMode.REQUIRED;
    const key = TransactionManager.contextKey(adapterName, instanceName);

    const existing = TransactionContext.getActiveTransaction(key);

    switch (propagation) {
      case PropagationMode.REQUIRED: {
        if (existing !== undefined) {
          this.noteJoinedRetry(options, propagation);
          return fn();
        }
        const adapter = this.registry.get(adapterName, instanceName);
        return this.startNewWithRetry(adapter, adapterName, instanceName, options, fn);
      }

      case PropagationMode.REQUIRES_NEW: {
        const adapter = this.registry.get(adapterName, instanceName);
        if (existing === undefined) {
          return this.startNewWithRetry(adapter, adapterName, instanceName, options, fn);
        }
        TransactionContext.removeActiveTransaction(key);
        try {
          return await this.startNewWithRetry(adapter, adapterName, instanceName, options, fn);
        } finally {
          TransactionContext.setActiveTransaction(key, existing);
        }
      }

      case PropagationMode.NESTED: {
        const adapter = this.registry.get(adapterName, instanceName);
        if (existing === undefined) {
          return this.startNewWithRetry(adapter, adapterName, instanceName, options, fn);
        }
        this.noteJoinedRetry(options, propagation);
        return this.runNestedSavepoint(adapter, existing, options, fn);
      }

      case PropagationMode.SUPPORTS: {
        return fn();
      }

      case PropagationMode.NOT_SUPPORTED: {
        if (existing === undefined) {
          return fn();
        }
        TransactionContext.removeActiveTransaction(key);
        try {
          return await fn();
        } finally {
          TransactionContext.setActiveTransaction(key, existing);
        }
      }

      case PropagationMode.NEVER: {
        if (existing !== undefined) {
          throw new IllegalTransactionStateError(
            `Propagation NEVER cannot be invoked inside an active transaction ` +
              `(adapter: '${adapterName}', instance: '${instanceName}')`,
          );
        }
        return fn();
      }

      case PropagationMode.MANDATORY: {
        if (existing === undefined) {
          throw new IllegalTransactionStateError(
            `Propagation MANDATORY requires an active transaction, but none is ` +
              `active (adapter: '${adapterName}', instance: '${instanceName}')`,
          );
        }
        return fn();
      }
    }
  }

  /**
   * Compose the {@link TransactionContext} key for a given adapter
   * (type name) + instance pair. Manager and helper packages must agree
   * on this format so that `@nestjs-transactional/typeorm`'s
   * `getCurrentEntityManager` can find the transaction registered here.
   */
  private static contextKey(adapterName: string, instanceName: string): string {
    return `${adapterName}:${instanceName}`;
  }

  /**
   * Translate the user-facing options into the internal `(adapterName,
   * instanceName)` pair used to build the active-transaction Map key.
   *
   * Resolution order (DD-020):
   * 1. `options.dataSource` set: lookup the unique adapter via the
   *    registry by dataSource name. The dataSource name becomes the
   *    `instanceName`; the registry hands back the adapter type.
   * 2. Else: legacy path — `options.adapter` / `options.adapterInstance`
   *    fall back to the registry's defaults.
   */
  private resolveAdapterIdentifiers(options: ExtendedTransactionOptions): {
    adapterName: string;
    instanceName: string;
  } {
    if (options.dataSource !== undefined) {
      return {
        adapterName: this.registry.getAdapterNameByDataSource(options.dataSource),
        instanceName: options.dataSource,
      };
    }
    return {
      adapterName: options.adapter ?? this.registry.getDefaultAdapterName(),
      instanceName: options.adapterInstance ?? this.registry.getDefaultInstanceName(),
    };
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

  /**
   * The ORM's transaction object behind `active`, as its adapter's
   * {@link TransactionAdapter.nativeTransaction} returns it. This is what
   * a library that takes a transaction explicitly needs to write inside
   * the transaction `@Transactional` opened.
   *
   * @throws {IllegalTransactionStateError} If the adapter does not
   *   implement `nativeTransaction`.
   */
  nativeTransactionOf(active: ActiveTransaction): unknown {
    const adapter = this.registry.get(active.adapterName, active.adapterInstanceName);
    if (adapter.nativeTransaction === undefined) {
      throw new IllegalTransactionStateError(
        `The '${active.adapterName}' adapter for dataSource '${active.adapterInstanceName}' does not ` +
          'expose its native transaction (TransactionAdapter.nativeTransaction), so a library that ' +
          'takes a transaction explicitly cannot join it.',
      );
    }
    return adapter.nativeTransaction(active.handle);
  }

  /**
   * The database dialect of `active`'s adapter
   * ({@link TransactionAdapter.dialect}), or `undefined` when the adapter
   * does not report one. Bridges use it for checks that hold on one
   * dialect only.
   */
  dialectOf(active: ActiveTransaction): string | undefined {
    return this.registry.get(active.adapterName, active.adapterInstanceName).dialect;
  }

  /**
   * Make COMMIT of `active` wait for `pending`, a write some library
   * started inside the transaction without the caller awaiting it. If
   * `pending` rejects, the transaction rolls back with that error.
   *
   * One before-commit hook per transaction drains every tracked promise,
   * including those tracked while it drains. A rejection is observed at
   * once, so a transaction that fails for another reason does not leave
   * an unhandled rejection behind.
   */
  trackPending(active: ActiveTransaction, pending: Promise<unknown>): void {
    let set = this.pending.get(active);
    if (set === undefined) {
      set = new Set();
      this.pending.set(active, set);
      const drained = set;
      active.beforeCommitHooks.push(async () => {
        while (drained.size > 0) {
          const batch = [...drained];
          drained.clear();
          await Promise.all(batch);
        }
      });
    }
    pending.catch(() => undefined);
    set.add(pending);
  }

  /**
   * {@link startNew}, run again while `options.retry` allows: the
   * transaction rolled back, the error is retryable, and attempts remain
   * (DD-032). Each attempt is a fresh transaction with fresh hooks.
   */
  private async startNewWithRetry<T>(
    adapter: TransactionAdapter,
    adapterName: string,
    instanceName: string,
    options: ExtendedTransactionOptions,
    fn: () => Promise<T>,
  ): Promise<T> {
    const retry = normalizeRetry(options.retry);
    if (retry === undefined) {
      return this.startNew(adapter, adapterName, instanceName, options, fn);
    }
    const retryable =
      retry.retryIf ?? ((error: unknown) => adapter.isRetryableError?.(error) === true);
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.startNew(adapter, adapterName, instanceName, options, fn);
      } catch (error) {
        const rolledBack =
          typeof error === 'object' && error !== null && this.rolledBack.has(error);
        if (attempt >= retry.maxAttempts || !rolledBack || !retryable(error)) {
          throw error;
        }
        const wait = retry.delay(attempt, error);
        this.logger.debug(
          `Transaction on '${instanceName}' failed with a retryable error; attempt ${attempt + 1} ` +
            `of ${retry.maxAttempts} in ${wait} ms: ${error instanceof Error ? error.message : typeof error}`,
        );
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
      }
    }
  }

  /**
   * A `retry` on a call that joins an outer transaction cannot apply: the
   * transaction is the outer one's. Said once per call site, at debug.
   */
  private noteJoinedRetry(options: ExtendedTransactionOptions, propagation: PropagationMode): void {
    if (options.retry !== undefined) {
      this.logger.debug(
        `retry is ignored on a ${propagation} call that joins an outer transaction; ` +
          'put it on the outermost @Transactional.',
      );
    }
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
    const startTime = Date.now();
    const key = TransactionManager.contextKey(adapterName, instanceName);

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
            TransactionContext.setActiveTransaction(key, activeTx);

            this.notifyStart({
              transactionId: handle.id,
              adapterName,
              adapterInstanceName: instanceName,
              correlationId,
              options,
            });

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
              TransactionContext.removeActiveTransaction(key);
            }
          },
        );
      } catch (rollbackError) {
        if (activeTx !== undefined) {
          this.notifyRollback({
            transactionId: activeTx.handle.id,
            adapterName,
            adapterInstanceName: instanceName,
            correlationId,
            options,
            durationMs: Date.now() - startTime,
            error: rollbackError,
            rollbackCount: activeTx.afterRollbackHooks.length,
          });
          await this.runHooks(activeTx.afterRollbackHooks, rollbackError);
        }
        if (typeof rollbackError === 'object' && rollbackError !== null) {
          this.rolledBack.add(rollbackError);
        }
        throw rollbackError;
      }

      // Adapter has committed. Fire the observer event and afterCommit
      // hooks regardless of whether we are about to re-raise a business
      // error — the database state is what the subscribers care about,
      // and it has been persisted.
      if (activeTx !== undefined) {
        this.notifyCommit({
          transactionId: activeTx.handle.id,
          adapterName,
          adapterInstanceName: instanceName,
          correlationId,
          options,
          durationMs: Date.now() - startTime,
          commitCount: activeTx.afterCommitHooks.length,
        });
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

  private notifyStart(ctx: TransactionStartContext): void {
    for (const observer of this.observers) {
      try {
        observer.onTransactionStart?.(ctx);
      } catch (err) {
        this.logger.warn(
          `TransactionObserver.onTransactionStart failed: ${String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
  }

  private notifyCommit(ctx: TransactionCommitContext): void {
    for (const observer of this.observers) {
      try {
        observer.onTransactionCommit?.(ctx);
      } catch (err) {
        this.logger.warn(
          `TransactionObserver.onTransactionCommit failed: ${String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
  }

  private notifyRollback(ctx: TransactionRollbackContext): void {
    for (const observer of this.observers) {
      try {
        observer.onTransactionRollback?.(ctx);
      } catch (err) {
        this.logger.warn(
          `TransactionObserver.onTransactionRollback failed: ${String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }
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

interface NormalizedRetry {
  readonly maxAttempts: number;
  readonly delay: (attempt: number, error: unknown) => number;
  readonly retryIf?: (error: unknown) => boolean;
}

/** The default backoff: exponential from 10 ms, capped at 1 s, full jitter. */
function defaultDelay(attempt: number): number {
  return Math.floor(Math.random() * Math.min(1000, 10 * 2 ** (attempt - 1)));
}

function normalizeRetry(retry: ExtendedTransactionOptions['retry']): NormalizedRetry | undefined {
  if (retry === undefined) {
    return undefined;
  }
  const options = typeof retry === 'number' ? { maxAttempts: retry } : retry;
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new TypeError(
      `retry.maxAttempts must be an integer of at least 1, got ${String(options.maxAttempts)}.`,
    );
  }
  const { delay } = options;
  return {
    maxAttempts: options.maxAttempts,
    delay:
      typeof delay === 'function' ? delay : typeof delay === 'number' ? () => delay : defaultDelay,
    retryIf: options.retryIf,
  };
}
