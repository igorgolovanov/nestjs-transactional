import { Logger } from '@nestjs/common';
import {
  type ActiveTransaction,
  IllegalTransactionStateError,
  TransactionContext,
} from '@nestjs-transactional/core';

import type { EventPublicationRegistry } from '../registry/event-publication-registry';
import type { OutboxListenerRegistry } from '../registry/listener-registry';

/**
 * Per-dataSource publisher (Phase 14.3). Owns the per-transaction
 * buffer, lifecycle hook registration, and delegate calls into the
 * `EventPublicationRegistry` bound to a single dataSource.
 *
 * Not user-facing — application code injects the smart facade
 * {@link OutboxEventPublisher}, which routes events to the
 * `DataSourceOutboxPublisher` whose dataSource owns the event class.
 * Exported nonetheless because:
 *   - tests may want to drive a per-DS publisher directly
 *   - advanced consumers (e.g. cross-DS bridges) may need the
 *     dataSource-bound surface
 *
 * Single-DS deployments still resolve `OutboxEventPublisher` from DI
 * — the facade transparently delegates to the only registered
 * `DataSourceOutboxPublisher`.
 */
export class DataSourceOutboxPublisher {
  private readonly logger: Logger;

  // Per-transaction buffer of events awaiting flush. Keyed by the
  // ActiveTransaction object itself so the entry is GC'd with the
  // transaction — no cleanup code to maintain, and no risk of
  // cross-transaction leakage.
  private readonly pending = new WeakMap<ActiveTransaction, unknown[]>();

  /**
   * @param dataSource Public dataSource name this publisher binds to.
   *   Used as the lookup key for the active transaction (DD-023) and
   *   surfaced in error messages.
   * @param registry Per-DS {@link EventPublicationRegistry}.
   * @param listenerRegistry Per-DS {@link OutboxListenerRegistry}.
   */
  constructor(
    readonly dataSource: string,
    private readonly registry: EventPublicationRegistry,
    private readonly listenerRegistry: OutboxListenerRegistry,
  ) {
    this.logger = new Logger(`DataSourceOutboxPublisher[${dataSource}]`);
  }

  /**
   * Publish a single event into this dataSource's outbox. Must be
   * called inside an active transaction *for this dataSource*. Throws
   * {@link IllegalTransactionStateError} otherwise — the publication
   * row must commit atomically with the business write, and the
   * specific dataSource's transaction is the only context that can
   * provide that atomicity.
   *
   * Creates one publication entry per listener registered for the
   * event type. Zero listeners is a silent no-op (but the
   * active-transaction check still applies).
   */
  async publish(event: unknown): Promise<void> {
    this.ensureActiveTransaction();

    const eventType = (event as object).constructor.name;
    const listeners = this.listenerRegistry.getByEventType(eventType);

    if (listeners.length === 0) {
      return;
    }

    const listenerIds = listeners.map((l) => l.id);
    await this.registry.publish(event, listenerIds);
  }

  /**
   * Publish a batch of events through this dataSource — same semantics
   * and same active-transaction check applied per event.
   */
  async publishAll(events: readonly unknown[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  /**
   * Synchronous scheduling for sync callers (e.g. `@nestjs/cqrs`'s
   * `AggregateRoot.commit()`). Inside a transaction *for this
   * dataSource*: events are buffered and flushed in a `beforeCommit`
   * hook. Outside any transaction (or no transaction for this DS):
   * fire-and-forget {@link publish}, errors logged.
   *
   * The hook is attached directly to this dataSource's `ActiveTransaction.beforeCommitHooks`
   * — `transactionManager.registerBeforeCommit` is NOT used because it
   * always targets "the first active transaction on the context",
   * which is the wrong target when multiple dataSources have live
   * transactions in the same async stack (Phase 14.2 cross-DS
   * simultaneous scenario).
   */
  scheduleForPublication(event: unknown): void {
    const tx = TransactionContext.getActiveTransactionByDataSource(this.dataSource);
    if (tx === undefined) {
      void this.publish(event).catch((err) => {
        this.logger.error(
          `scheduleForPublication outside an active '${this.dataSource}' transaction failed: ${
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

      // Push the hook onto THIS specific transaction's hook list —
      // not via transactionManager.registerBeforeCommit which targets
      // the first-active transaction (wrong with multi-DS).
      tx.beforeCommitHooks.push(async () => {
        const toFlush = this.pending.get(tx);
        this.pending.delete(tx);
        if (toFlush !== undefined && toFlush.length > 0) {
          await this.publishAll(toFlush);
        }
      });
    }
    buffer.push(event);
  }

  private ensureActiveTransaction(): void {
    const tx = TransactionContext.getActiveTransactionByDataSource(this.dataSource);
    if (tx === undefined) {
      throw new IllegalTransactionStateError(
        `OutboxEventPublisher.publish for dataSource '${this.dataSource}' must be ` +
          `called inside an active transaction for that dataSource. Wrap the call ` +
          `in @Transactional({ dataSource: '${this.dataSource}' }) so the publication ` +
          `row commits atomically with the business write.`,
      );
    }
  }
}

