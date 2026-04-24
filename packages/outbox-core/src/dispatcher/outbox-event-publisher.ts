import { Injectable } from '@nestjs/common';
import {
  IllegalTransactionStateError,
  TransactionContext,
  TransactionManager,
} from '@nestjs-transactional/core';

import { EventPublicationRegistry } from '../registry/event-publication-registry';
import { OutboxListenerRegistry } from '../registry/listener-registry';

/**
 * High-level API that business code uses to publish events.
 *
 * For a given event, looks up every `@OutboxEventListener` currently
 * registered for that event type and asks the
 * {@link EventPublicationRegistry} to persist one publication per
 * listener — atomically with the ambient transaction.
 *
 * Delivery itself happens asynchronously after commit, via the
 * upcoming `EventPublicationProcessor` (Phase 5.9).
 *
 * This class intentionally refuses to run outside a transaction:
 * publications must be committed with the business write, and calling
 * `publish` outside a transaction is almost always a bug.
 */
@Injectable()
export class OutboxEventPublisher {
  constructor(
    private readonly registry: EventPublicationRegistry,
    private readonly listenerRegistry: OutboxListenerRegistry,
    // Reserved for upcoming iterations — e.g. registering a beforeCommit
    // hook for per-event validation or per-event tracing.
    private readonly transactionManager: TransactionManager,
  ) {
    void this.transactionManager;
  }

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
