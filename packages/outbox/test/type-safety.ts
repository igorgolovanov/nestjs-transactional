/**
 * Compile-time proof that `@OutboxEventsHandler` +
 * `IOutboxEventsHandler` enforce sensible type constraints. Not a
 * runtime test — jest's `testRegex` is `.*\.spec\.ts$`, so this
 * file is not executed.
 *
 * Every `@ts-expect-error` annotation below is a live assertion:
 * if TypeScript stops catching the underlying mistake, `tsc --noEmit`
 * reports "Unused '@ts-expect-error' directive" and the build
 * fails. This keeps the contract between the interface and the
 * decorator honest across refactors.
 */

import {
  type IOutboxEventsHandler,
  OutboxEventsHandler,
} from '../src';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class OrderCancelledEvent {
  constructor(readonly orderId: string) {}
}

// ─────────────────────────────────────────────────────────────────────
// Positive cases — these MUST compile.
// ─────────────────────────────────────────────────────────────────────

// 1. Short form with a single event.
@OutboxEventsHandler(OrderPlacedEvent)
export class SingleEventHandler implements IOutboxEventsHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent): Promise<void> {
    void event;
  }
}

// 2. Short form with multiple events, narrowed generic to their union.
@OutboxEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
export class MultiEventHandler
  implements IOutboxEventsHandler<OrderPlacedEvent | OrderCancelledEvent>
{
  async handle(event: OrderPlacedEvent | OrderCancelledEvent): Promise<void> {
    void event;
  }
}

// 3. Long form with explicit id + newTransaction: false.
@OutboxEventsHandler({
  events: [OrderPlacedEvent],
  id: 'stable-id',
  newTransaction: false,
})
export class NoTxHandler implements IOutboxEventsHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent): Promise<void> {
    void event;
  }
}

// 4. Default generic parameter — implements the interface without
//    narrowing, which is allowed because `IOutboxEventsHandler`
//    defaults to `any`. Consumers coming from `@nestjs/cqrs`'s
//    `implements IEventHandler` habits get the same ergonomics.
@OutboxEventsHandler(OrderPlacedEvent)
export class LooselyTypedHandler implements IOutboxEventsHandler {
  async handle(event: OrderPlacedEvent): Promise<void> {
    void event;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Negative cases — each `@ts-expect-error` below MUST fire.
// ─────────────────────────────────────────────────────────────────────

// N1. Missing `handle` method.
// @ts-expect-error — `implements` requires a `handle` method.
export class MissingHandleHandler
  implements IOutboxEventsHandler<OrderPlacedEvent> {}

// N2. `handle` returning `void` (sync) instead of `Promise<void>`.
//     `IOutboxEventsHandler` is async-only — handlers run from the
//     worker loop, which awaits the returned promise.
export class SyncHandler implements IOutboxEventsHandler<OrderPlacedEvent> {
  // @ts-expect-error — handle must return Promise<void>, not void.
  handle(event: OrderPlacedEvent): void {
    void event;
  }
}

// N3. `handle` returning a non-void-resolving Promise.
export class WrongResolvedTypeHandler
  implements IOutboxEventsHandler<OrderPlacedEvent>
{
  // @ts-expect-error — handle must resolve to void, not a string.
  async handle(event: OrderPlacedEvent): Promise<string> {
    void event;
    return 'nope';
  }
}

// N4. Decorator with empty events array throws at decoration time.
export function assertsEmptyEventsThrows(): void {
  try {
    OutboxEventsHandler({ events: [] });
    throw new Error('unreachable');
  } catch (err) {
    if (!(err instanceof Error) || !/at least one event type/.test(err.message)) {
      throw err;
    }
  }
}

// N5. Decorator with no arguments throws.
export function assertsNoArgsThrows(): void {
  try {
    (OutboxEventsHandler as () => ClassDecorator)();
    throw new Error('unreachable');
  } catch (err) {
    if (!(err instanceof Error) || !/at least one event type/.test(err.message)) {
      throw err;
    }
  }
}
