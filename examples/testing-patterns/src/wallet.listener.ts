import { Injectable, Logger } from '@nestjs/common';
import { OnOutboxMessage } from '@nestjs/outbox';

import type { WalletOperationEvent } from './events.js';

/**
 * Outbox-delivered listener. `WalletService` publishes
 * `WalletOperationEvent` through the outbox bridge, which adds it under
 * its class name; `@nestjs/outbox`'s relay delivers it here after the
 * wallet write commits, with retries and an inbox keyed by `consumer`.
 *
 * The integration test asserts both "the listener was invoked after the
 * wallet write committed" and "the listener was NOT invoked when the
 * write rolled back" (no message reaches the outbox at all).
 *
 * Captures invocations into a public array so tests do not need to spy
 * on instance methods. The payload is plain JSON, not an event instance.
 */
@Injectable()
export class WalletProjection {
  private readonly logger = new Logger(WalletProjection.name);

  invocations: WalletOperationEvent[] = [];

  @OnOutboxMessage('WalletOperationEvent', { consumer: 'wallet-projection' })
  async project(event: WalletOperationEvent): Promise<void> {
    this.invocations.push(event);
    this.logger.log(
      `outbox-delivered — wallet ${event.walletId} ${event.type} ${event.amount} → ${event.balanceAfter}`,
    );
  }
}
