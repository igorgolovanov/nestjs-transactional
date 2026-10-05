import { Inject, Injectable, Logger } from '@nestjs/common';
import { type NewOutboxMessage, Outbox } from '@nestjs/outbox';
import {
  type ActiveTransaction,
  IllegalTransactionStateError,
  TransactionContext,
} from '@nestjs-transactional/core';

import { getExternalizedMetadata } from '../externalization/externalized.decorator.js';
import { TRANSACTIONAL_OUTBOX_OPTIONS } from '../module/tokens.js';

/**
 * Turns the active transaction into what `outbox.add()` takes as `tx`.
 * The default handles TypeORM's handle, `{ entityManager }`.
 */
export type OutboxTransactionResolver = (active: ActiveTransaction) => unknown;

export interface TransactionalOutboxOptions {
  /** The DataSource whose transactions carry the outbox. Defaults to `'default'`. */
  readonly dataSource?: string;
  /** See {@link OutboxTransactionResolver}. */
  readonly transactionResolver?: OutboxTransactionResolver;
}

/** The header carrying the event's class name on every message. */
export const EVENT_TYPE_HEADER = 'x-event-type';

/**
 * Adds events to `@nestjs/outbox` inside the transaction `@Transactional`
 * opened, so nothing passes the transaction by hand (DD-028).
 *
 * The message commits or rolls back with the business rows. An
 * `@Externalized` event goes to its target; any other event to a topic
 * named after its class, for `@OnOutboxMessage` to handle in-process.
 */
@Injectable()
export class OutboxEventPublisher {
  private readonly logger = new Logger(OutboxEventPublisher.name);
  private readonly dataSource: string;
  private readonly resolveTransaction: OutboxTransactionResolver;
  private readonly pending = new WeakMap<ActiveTransaction, object[]>();
  private readonly notifying = new WeakSet<ActiveTransaction>();

  constructor(
    private readonly outbox: Outbox,
    @Inject(TRANSACTIONAL_OUTBOX_OPTIONS) options: TransactionalOutboxOptions = {},
  ) {
    this.dataSource = options.dataSource ?? 'default';
    this.resolveTransaction = options.transactionResolver ?? entityManagerOf;
  }

  /**
   * Adds the event to the outbox in the current transaction.
   *
   * @throws IllegalTransactionStateError outside a transaction on the
   *   outbox's DataSource, including when another DataSource has one.
   */
  async publish(event: object): Promise<void> {
    const active = this.requireTransaction();
    await this.outbox.add(this.resolveTransaction(active), toMessage(event));
    this.notifyAfterCommit(active);
  }

  /** {@link publish} for each event, in order. */
  async publishAll(events: readonly object[]): Promise<void> {
    for (const event of events) {
      await this.publish(event);
    }
  }

  /**
   * The synchronous path, for `AggregateRoot.commit()` through the cqrs
   * `HybridEventPublisher`. `@Externalized` events are buffered and added
   * by one before-commit hook, so they still commit with the transaction.
   * Other events are left to the in-memory dispatcher. With no
   * transaction, the event is dropped and logged, because a synchronous
   * caller cannot be given the error.
   */
  scheduleForPublication(event: object): void {
    if (getExternalizedMetadata(event.constructor) === undefined) {
      return;
    }

    const active = TransactionContext.getActiveTransactionByDataSource(this.dataSource);
    if (active === undefined) {
      this.logger.error(
        `${event.constructor.name} was dropped: it was committed outside a transaction on ` +
          `dataSource '${this.dataSource}', so it cannot be added to the outbox atomically.`,
      );
      return;
    }

    let buffer = this.pending.get(active);
    if (buffer === undefined) {
      buffer = [];
      this.pending.set(active, buffer);
      active.beforeCommitHooks.push(async () => {
        const events = this.pending.get(active) ?? [];
        this.pending.delete(active);
        await this.publishAll(events);
      });
    }
    buffer.push(event);
  }

  private requireTransaction(): ActiveTransaction {
    const active = TransactionContext.getActiveTransactionByDataSource(this.dataSource);
    if (active !== undefined) {
      return active;
    }

    const others = [...(TransactionContext.getStore()?.activeTransactions.values() ?? [])].map(
      (tx) => `'${tx.adapterInstanceName}'`,
    );
    throw new IllegalTransactionStateError(
      others.length === 0
        ? `OutboxEventPublisher.publish() must run inside a transaction on dataSource ` +
            `'${this.dataSource}', so the message commits with the business write. ` +
            `Wrap the call in @Transactional().`
        : `OutboxEventPublisher.publish() needs a transaction on dataSource ` +
            `'${this.dataSource}', where the outbox lives, but only ${others.join(', ')} ` +
            `has one. Adding the message there would not be atomic with these writes.`,
    );
  }

  private notifyAfterCommit(active: ActiveTransaction): void {
    if (this.notifying.has(active)) {
      return;
    }
    this.notifying.add(active);
    active.afterCommitHooks.push(() => {
      this.outbox.notify();
      return Promise.resolve();
    });
  }
}

function toMessage(event: object): NewOutboxMessage {
  const eventType = event.constructor.name;
  const meta = getExternalizedMetadata(event.constructor);
  const headers = typeof meta?.headers === 'function' ? meta.headers(event) : (meta?.headers ?? {});

  return {
    topic: meta?.target ?? eventType,
    payload: event,
    ...(meta?.routingKey === undefined ? {} : { key: meta.routingKey(event) }),
    headers: { ...headers, [EVENT_TYPE_HEADER]: eventType },
  };
}

function entityManagerOf(active: ActiveTransaction): unknown {
  const entityManager = (active.handle as { entityManager?: unknown }).entityManager;
  if (entityManager === undefined) {
    throw new IllegalTransactionStateError(
      `The '${active.adapterName}' transaction handle has no entityManager, which the ` +
        `default transactionResolver expects (TypeORM). Pass a transactionResolver to ` +
        `TransactionalOutboxModule.forRoot() that returns what @nestjs/outbox's store ` +
        `takes as a transaction for this adapter.`,
    );
  }
  return entityManager;
}
