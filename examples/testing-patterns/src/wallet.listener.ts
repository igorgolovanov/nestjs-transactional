import { Injectable, Logger } from '@nestjs/common';
import {
  type IIntegrationEventHandler,
  IntegrationEventsHandler,
} from '@nestjs-transactional/cqrs';

import { WalletOperationEvent } from './events';

/**
 * Outbox-routed listener. `@IntegrationEventsHandler` switches
 * between durable (outbox-routed) and in-memory delivery based on
 * module wiring; this example wires the outbox, so the worker
 * polls `event_publication`, picks up the row, and invokes
 * `handle()` in a fresh transaction.
 *
 * The integration test asserts both "the listener was invoked
 * after the wallet write committed" (with `waitFor` because
 * delivery is asynchronous) and "the listener was NOT invoked
 * when the write rolled back" (no row reaches the outbox at all).
 *
 * Captures invocations into a public array so tests do not need to
 * spy on instance methods.
 */
@Injectable()
@IntegrationEventsHandler({ events: [WalletOperationEvent], id: 'WalletProjection' })
export class WalletProjection implements IIntegrationEventHandler<WalletOperationEvent> {
  private readonly logger = new Logger(WalletProjection.name);

  invocations: WalletOperationEvent[] = [];

  async handle(event: WalletOperationEvent): Promise<void> {
    this.invocations.push(event);
    this.logger.log(
      `outbox-delivered — wallet ${event.walletId} ${event.type} ${event.amount} → ${event.balanceAfter}`,
    );
  }
}
