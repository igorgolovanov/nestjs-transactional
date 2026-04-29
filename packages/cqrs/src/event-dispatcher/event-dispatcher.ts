import { Injectable, Logger, type Type } from '@nestjs/common';
import {
  type ActiveTransaction,
  DEFAULT_DATA_SOURCE_NAME,
  TransactionContext,
  TransactionManager,
} from '@nestjs-transactional/core';

import { TransactionPhase } from '../types/transactional-listener.types';

/**
 * Resolved per-event-type listener configuration used by
 * {@link TransactionalEventDispatcher.registerListener}. Scanners flatten
 * class-level `@TransactionalEventsHandler` metadata (which lists many
 * event types per class) into one of these entries per event type.
 */
export interface DispatcherListenerMetadata {
  readonly eventType: Type;
  readonly phase: TransactionPhase;
  readonly fallbackExecution: boolean;
  readonly async: boolean;
  /**
   * dataSource the listener's phase hooks attach to (Phase 14.3.1).
   * Optional for backward compatibility — when omitted, defaults to
   * `'default'`. Scanners normalise from decorator metadata before
   * calling {@link TransactionalEventDispatcher.registerListener}.
   */
  readonly dataSource?: string;
}

/**
 * Method shape expected of a registered listener: a function that
 * accepts the domain event as its first argument and, for
 * {@link TransactionPhase.AFTER_ROLLBACK} /
 * {@link TransactionPhase.AFTER_COMPLETION} listeners, the causing
 * error as its second.
 */
type ListenerMethod = (event: unknown, error?: unknown) => unknown;

/**
 * Internal record of one handler method known to a dispatcher.
 * Populated via {@link TransactionalEventDispatcher.registerListener}
 * by a scanner at bootstrap. The method is bound to its instance at
 * registration time so dispatch does no string-keyed lookup.
 */
interface RegisteredListener {
  readonly handler: ListenerMethod;
  readonly instanceLabel: string;
  readonly methodName: string;
  readonly metadata: DispatcherListenerMetadata;
}

/**
 * Routes domain events to methods registered by scanners for
 * `@TransactionalEventsHandler`-annotated classes, honouring the
 * requested {@link TransactionPhase}:
 *
 * - Inside an active transaction, the listener is attached to the
 *   transaction as a before-commit / after-commit / after-rollback
 *   hook via {@link TransactionManager}. Phase AFTER_COMPLETION
 *   attaches to both after-commit and after-rollback.
 * - Outside any transaction, listeners with `fallbackExecution: true`
 *   are invoked via `queueMicrotask`; others are dropped with a
 *   warning.
 *
 * Error propagation:
 * - Errors thrown from a BEFORE_COMMIT listener propagate through the
 *   manager's commit path and trigger rollback (matches Spring).
 * - Errors thrown from an AFTER_COMMIT / AFTER_ROLLBACK /
 *   AFTER_COMPLETION listener are logged and swallowed by
 *   {@link TransactionManager}'s hook runner — the transaction
 *   outcome is already decided.
 * - `async: true` listeners are fire-and-forget via `queueMicrotask`:
 *   their failures are logged but never reach the enclosing
 *   transaction, even in BEFORE_COMMIT phase.
 *
 * **Multi-dataSource (Phase 14.3.1).** Hook attachment is per-dataSource:
 * the dispatcher resolves the listener's bound dataSource via
 * `TransactionContext.getActiveTransactionByDataSource(dataSource)`
 * and pushes hooks directly onto that transaction's hook list,
 * bypassing `TransactionManager.registerBeforeCommit`'s first-active-tx
 * semantics. The dataSource comes from the listener metadata (defaults
 * to `'default'`); scanners populate it from the
 * `@TransactionalEventsHandler({ dataSource })` /
 * `@IntegrationEventsHandler({ dataSource })` option. Cross-DS
 * simultaneous transactions therefore route deterministically — a
 * billing-bound handler attaches to the billing transaction's hooks
 * even when an inventory transaction is also active on the same
 * async stack.
 */
@Injectable()
export class TransactionalEventDispatcher {
  private readonly logger = new Logger(TransactionalEventDispatcher.name);
  private readonly listenersByType = new Map<string, RegisteredListener[]>();

  /**
   * `manager` is no longer consulted after Phase 14.3.1 — the
   * dispatcher pushes hooks directly onto the per-dataSource
   * `ActiveTransaction` resolved via `TransactionContext`. The
   * parameter is preserved as a constructor argument so existing
   * `new TransactionalEventDispatcher(manager)` callsites in tests
   * keep compiling. NestJS DI continues to inject the manager
   * automatically. A future cleanup phase may drop it.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly manager: TransactionManager) {}

  /**
   * Register a handler method discovered on `instance`. The lookup key
   * is `metadata.eventType.name` — see {@link scheduleDispatch} for
   * matching semantics. Multiple handlers for the same event are
   * invoked in registration order within the hook runner.
   *
   * @throws {TypeError} If `instance[methodName]` is not a function.
   *   This is a caller contract violation — the scanner must only pass
   *   method names that actually resolve to methods on the instance.
   */
  registerListener(
    instance: object,
    methodName: string,
    metadata: DispatcherListenerMetadata,
  ): void {
    const rawMethod = (instance as Record<string, unknown>)[methodName];
    if (typeof rawMethod !== 'function') {
      throw new TypeError(
        `Transactional event handler target ${instance.constructor.name}.${methodName} ` +
          `is not a function — cannot register as a listener`,
      );
    }

    const typeName = metadata.eventType.name;
    const instanceLabel = instance.constructor.name;
    const entry: RegisteredListener = {
      handler: (rawMethod as ListenerMethod).bind(instance),
      instanceLabel,
      methodName,
      metadata,
    };

    const listeners = this.listenersByType.get(typeName);
    if (listeners === undefined) {
      this.listenersByType.set(typeName, [entry]);
    } else {
      listeners.push(entry);
    }

    this.logger.debug(
      `Registered handler ${instanceLabel}.${methodName} for ${typeName} phase=${metadata.phase}`,
    );
  }

  /**
   * Route `event` to every listener registered for its exact
   * constructor name. Listener matching is nominal and non-inheriting:
   * a listener registered for `Parent` is NOT invoked for a `Child
   * extends Parent` event, because the lookup uses
   * `event.constructor.name`.
   */
  scheduleDispatch(event: object): void {
    const typeName = event.constructor.name;
    const listeners = this.listenersByType.get(typeName);
    if (listeners === undefined || listeners.length === 0) {
      return;
    }

    const store = TransactionContext.getStore();
    const anyTxActive = store !== undefined && store.activeTransactions.size > 0;

    for (const listener of listeners) {
      const dataSource = listener.metadata.dataSource ?? DEFAULT_DATA_SOURCE_NAME;
      const tx = TransactionContext.getActiveTransactionByDataSource(dataSource);

      if (tx === undefined) {
        // No active transaction for this listener's dataSource. Two
        // sub-cases:
        //  - There IS at least one active tx (just not for this DS):
        //    the event is "in a transaction" only for some other DS.
        //    A listener bound to a different DS has no business
        //    firing — skip silently. This preserves DD-023's
        //    independent-context semantics (cross-dataSource calls
        //    do not silently enrol).
        //  - No active tx anywhere: classic out-of-transaction case —
        //    fallbackExecution: true fires immediately, others warn
        //    and drop.
        if (!anyTxActive && listener.metadata.fallbackExecution) {
          this.scheduleFallback(listener, event);
        } else if (!anyTxActive) {
          this.logger.warn(
            `Event ${typeName} published outside a transaction; handler ` +
              `${listener.instanceLabel}.${listener.methodName} has no ` +
              `fallbackExecution=true — skipping.`,
          );
        } else {
          this.logger.debug(
            `Event ${typeName}: handler ${listener.instanceLabel}.${listener.methodName} ` +
              `bound to dataSource '${dataSource}' has no matching active transaction — skipping.`,
          );
        }
        continue;
      }

      this.attachHookToTransaction(listener, event, tx);
    }
  }

  private attachHookToTransaction(
    listener: RegisteredListener,
    event: object,
    tx: ActiveTransaction,
  ): void {
    const invoke = (): Promise<void> => this.invokeListener(listener, event);
    const invokeWithError = (error: unknown): Promise<void> =>
      this.invokeListener(listener, event, error);

    // Push hooks directly onto THIS specific transaction's hook lists,
    // bypassing TransactionManager.registerBeforeCommit's
    // first-active-tx resolution. Same pattern as
    // DataSourceOutboxPublisher.scheduleForPublication (Phase 14.3).
    switch (listener.metadata.phase) {
      case TransactionPhase.BEFORE_COMMIT:
        tx.beforeCommitHooks.push(invoke);
        return;
      case TransactionPhase.AFTER_COMMIT:
        tx.afterCommitHooks.push(invoke);
        return;
      case TransactionPhase.AFTER_ROLLBACK:
        tx.afterRollbackHooks.push(invokeWithError);
        return;
      case TransactionPhase.AFTER_COMPLETION:
        tx.afterCommitHooks.push(invoke);
        tx.afterRollbackHooks.push(invokeWithError);
        return;
    }
  }

  private async invokeListener(
    listener: RegisteredListener,
    event: unknown,
    error?: unknown,
  ): Promise<void> {
    if (listener.metadata.async) {
      queueMicrotask(() => {
        try {
          const result = this.callListener(listener, event, error);
          if (result instanceof Promise) {
            result.catch((err: unknown) => this.logListenerFailure(listener, err));
          }
        } catch (err) {
          this.logListenerFailure(listener, err);
        }
      });
      return;
    }

    try {
      const result = this.callListener(listener, event, error);
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      this.logListenerFailure(listener, err);
      // Rethrow so BEFORE_COMMIT failures reach the manager's rollback path.
      // For AFTER_COMMIT/AFTER_ROLLBACK/AFTER_COMPLETION the manager's
      // hook runner swallows the error after a warn-level log.
      throw err;
    }
  }

  private scheduleFallback(listener: RegisteredListener, event: object): void {
    queueMicrotask(() => {
      try {
        const result = this.callListener(listener, event);
        if (result instanceof Promise) {
          result.catch((err: unknown) => this.logListenerFailure(listener, err));
        }
      } catch (err) {
        this.logListenerFailure(listener, err);
      }
    });
  }

  private callListener(listener: RegisteredListener, event: unknown, error?: unknown): unknown {
    return listener.handler(event, error);
  }

  private logListenerFailure(listener: RegisteredListener, err: unknown): void {
    this.logger.error(
      `Transactional event handler ${listener.instanceLabel}.${listener.methodName} failed`,
      err instanceof Error ? err.stack : String(err),
    );
  }
}
