/**
 * Compile-time proof that the class-level handler API enforces
 * sensible type constraints. This file is **not** a runtime test —
 * jest's `testRegex` is `.*\.spec\.ts$`, so it is not executed.
 *
 * What it checks: the TypeScript compiler rejects
 * malformed handler shapes. Every `@ts-expect-error` annotation is
 * a live assertion — if TypeScript stops catching the underlying
 * mistake (e.g. because the interface signature drifted),
 * `tsc --noEmit` will report "Unused '@ts-expect-error' directive"
 * and the build fails.
 *
 * Method parameter-type variance note: TypeScript's method
 * declarations are bivariant even under `strict: true` — only
 * function-type properties get contravariance. For that reason
 * we assert against return-type and shape mismatches rather than
 * against the event-parameter type; the latter cannot be reliably
 * caught at compile time and has to be enforced by convention +
 * explicit `implements I<SpecificEvent>`.
 */

import {
  IntegrationEventsHandler,
  type IIntegrationEventsHandler,
  type ITransactionalEventsHandler,
  TransactionPhase,
  TransactionalEventsHandler,
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

// 1. Short form with one event, sync handle returning void.
@TransactionalEventsHandler(OrderPlacedEvent)
export class SyncVoidHandler implements ITransactionalEventsHandler<OrderPlacedEvent> {
  handle(event: OrderPlacedEvent): void {
    void event;
  }
}

// 2. Short form with multiple events, async handle returning Promise<void>.
@TransactionalEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
export class MultiEventAsyncHandler
  implements ITransactionalEventsHandler<OrderPlacedEvent | OrderCancelledEvent>
{
  async handle(event: OrderPlacedEvent | OrderCancelledEvent): Promise<void> {
    void event;
    await Promise.resolve();
  }
}

// 3. Long form with all options.
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  phase: TransactionPhase.BEFORE_COMMIT,
  async: true,
  fallbackExecution: true,
})
export class FullyConfiguredHandler
  implements ITransactionalEventsHandler<OrderPlacedEvent>
{
  handle(event: OrderPlacedEvent): void {
    void event;
  }
}

// 4. Handler widening the method signature with an optional error
//    parameter — permitted by TypeScript because implementations may
//    add optional parameters beyond the interface contract. Matches
//    the AFTER_ROLLBACK dispatcher behaviour, which calls
//    `handle(event, error)`.
@TransactionalEventsHandler({
  events: [OrderPlacedEvent],
  phase: TransactionPhase.AFTER_ROLLBACK,
})
export class RollbackHandlerWithError
  implements ITransactionalEventsHandler<OrderPlacedEvent>
{
  handle(event: OrderPlacedEvent, error?: unknown): void {
    void event;
    void error;
  }
}

// 5. @IntegrationEventsHandler short form.
@IntegrationEventsHandler(OrderPlacedEvent)
export class CrossModuleHandler implements IIntegrationEventsHandler<OrderPlacedEvent> {
  async handle(event: OrderPlacedEvent): Promise<void> {
    void event;
  }
}

// 6. @IntegrationEventsHandler long form with stable id.
@IntegrationEventsHandler({ events: [OrderPlacedEvent], id: 'stable-id' })
export class StableIdHandler implements IIntegrationEventsHandler<OrderPlacedEvent> {
  handle(event: OrderPlacedEvent): void {
    void event;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Negative cases — each `@ts-expect-error` below MUST fire.
// If any of these compiles without error, the build breaks with
// "Unused '@ts-expect-error' directive".
// ─────────────────────────────────────────────────────────────────────

// N1. Missing `handle` method.
// @ts-expect-error — `implements` requires a `handle` method.
export class MissingHandleHandler
  implements ITransactionalEventsHandler<OrderPlacedEvent> {}

// N2. `handle` returning a non-void, non-Promise type.
export class WrongReturnTypeHandler
  implements ITransactionalEventsHandler<OrderPlacedEvent>
{
  // @ts-expect-error — handle must return void | Promise<void>, not string.
  handle(event: OrderPlacedEvent): string {
    void event;
    return 'nope';
  }
}

// N3. `IIntegrationEventsHandler` with a non-void-returning handle.
export class WrongReturnTypeIntegrationEventsHandler
  implements IIntegrationEventsHandler<OrderPlacedEvent>
{
  // @ts-expect-error — handle must return void | Promise<void>, not number.
  handle(event: OrderPlacedEvent): number {
    void event;
    return 42;
  }
}

// N4. Empty events array passed to @TransactionalEventsHandler's
//     options form must be a runtime error — TypeScript cannot enforce
//     non-empty arrays, so this is an explicit decoration-time throw.
//     Smoke-test with an actual decorator call below.
export function assertsEmptyEventsThrows(): void {
  try {
    // The decorator throws on invocation; the call itself is valid TS.
    TransactionalEventsHandler({ events: [] });
    throw new Error('unreachable');
  } catch (err) {
    if (!(err instanceof Error) || !/at least one event type/.test(err.message)) {
      throw err;
    }
  }
}

// N5. Calling the decorator with no arguments also throws.
export function assertsNoArgsThrows(): void {
  try {
    (TransactionalEventsHandler as () => ClassDecorator)();
    throw new Error('unreachable');
  } catch (err) {
    if (!(err instanceof Error) || !/at least one event type/.test(err.message)) {
      throw err;
    }
  }
}
