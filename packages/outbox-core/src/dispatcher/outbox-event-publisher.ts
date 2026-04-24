import { Injectable, Logger } from '@nestjs/common';
import {
  type ActiveTransaction,
  IllegalTransactionStateError,
  TransactionContext,
  TransactionManager,
} from '@nestjs-transactional/core';

import { EventPublicationRegistry } from '../registry/event-publication-registry';
import { OutboxListenerRegistry } from '../registry/listener-registry';

/**
 * High-level API that business code uses to publish events.
 *
 * For a given event, looks up every `@OutboxEventsHandler` currently
 * registered for that event type and asks the
 * {@link EventPublicationRegistry} to persist one publication per
 * listener — atomically with the ambient transaction.
 *
 * Delivery itself happens asynchronously after commit, via the
 * `EventPublicationProcessor`.
 *
 * {@link publish} refuses to run outside a transaction: publications
 * must be committed with the business write, and calling
 * `publish` outside a transaction is almost always a bug.
 *
 * {@link scheduleForPublication} is a synchronous sibling: it buffers
 * events inside the current transaction and flushes them in a
 * `beforeCommit` hook. Intended for sync callers such as
 * `@nestjs/cqrs`'s `AggregateRoot.commit()` pathway.
 */
@Injectable()
export class OutboxEventPublisher {
  private readonly logger = new Logger(OutboxEventPublisher.name);

  // Per-transaction buffer of events awaiting flush. Keyed by the
  // ActiveTransaction object itself so the entry is GC'd with the
  // transaction — no cleanup code to maintain, and no risk of
  // cross-transaction leakage.
  private readonly pending = new WeakMap<ActiveTransaction, unknown[]>();

  constructor(
    private readonly registry: EventPublicationRegistry,
    private readonly listenerRegistry: OutboxListenerRegistry,
    private readonly transactionManager: TransactionManager,
  ) {}

  /**
   * Publish a single event. Must be called inside an active
   * transaction — an `IllegalTransactionStateError` is thrown
   * otherwise.
   *
   * Creates one {@link EventPublication} per listener registered for
   * the event type. When no listeners are registered, the call is a
   * silent no-op (but the transaction check still applies — consistency
   * over leniency).
   */
  async publish(event: unknown): Promise<void> {
    this.ensureInTransaction();

    const eventType = (event as object).constructor.name;
    const listeners = this.listenerRegistry.getByEventType(eventType);

    if (listeners.length === 0) {
      return;
    }

    const listenerIds = listeners.map((l) => l.id);
    await this.registry.publish(event, listenerIds);
  }

  /**
   * Publish a batch of events inside the same transaction. Each event
   * is routed through {@link publish} — same semantics, same
   * transaction check.
   */
  async publishAll(events: readonly unknown[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  /**
   * Synchronous scheduling of an event for later publication. Designed
   * for sync callers that cannot await — notably
   * `@nestjs/cqrs`'s `AggregateRoot.commit()` which invokes publishers
   * via `IEventPublisher.publish`.
   *
   * Inside a transaction: the event is buffered per-transaction. The
   * first call per transaction registers a `beforeCommit` hook that
   * flushes the entire buffer via {@link publishAll} — a single hook
   * per transaction, not one per event. If the transaction rolls
   * back, the hook never fires and no publication rows are written —
   * this is the core guarantee of the outbox pattern.
   *
   * Outside a transaction: falls back to a fire-and-forget
   * {@link publish}. Errors are logged but not propagated (there is
   * no caller to propagate to on a sync path).
   */
  scheduleForPublication(event: unknown): void {
    const tx = findCurrentTransaction();
    if (tx === null) {
      void this.publish(event).catch((err) => {
        this.logger.error(
          `scheduleForPublication outside a transaction failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          err instanceof Error ? err.stack : undefined,
        );
      });
      return;
    }

    let buffer = this.pending.get(tx);
    if (buffer === undefined) {
      buffer = [];
      this.pending.set(tx, buffer);

      this.transactionManager.registerBeforeCommit(async () => {
        const toFlush = this.pending.get(tx);
        this.pending.delete(tx);
        if (toFlush !== undefined && toFlush.length > 0) {
          await this.publishAll(toFlush);
        }
      });
    }
    buffer.push(event);
  }

  private ensureInTransaction(): void {
    const store = TransactionContext.getStore();
    if (store === undefined || store.activeTransactions.size === 0) {
      throw new IllegalTransactionStateError(
        'OutboxEventPublisher.publish must be called inside an active transaction — ' +
          'publications must be committed atomically with the business write.',
      );
    }
  }
}

/**
 * Look up the innermost currently-active {@link ActiveTransaction} on
 * the async context, or return `null` when no transaction is active.
 * Mirrors `TransactionManager.currentTransaction()` — private in the
 * core package — without having to expose it.
 */
function findCurrentTransaction(): ActiveTransaction | null {
  const store = TransactionContext.getStore();
  if (store === undefined) {
    return null;
  }
  for (const tx of store.activeTransactions.values()) {
    return tx;
  }
  return null;
}
