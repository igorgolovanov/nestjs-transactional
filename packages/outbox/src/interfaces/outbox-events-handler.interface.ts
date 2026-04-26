/**
 * Contract implemented by classes annotated with
 * `@OutboxEventsHandler`. The worker invokes `handle(event)` for
 * every event of a type the class is registered for, with an
 * already-deserialised domain payload.
 *
 * `Promise<void>` — synchronous handlers are discouraged: the
 * worker loop awaits the returned promise, so a void-returning
 * implementation that synchronously performs I/O would block the
 * worker until that work completes. Make the operation explicit.
 *
 * Mirrors the ergonomics of `IEventHandler` from `@nestjs/cqrs` —
 * `any` as the default generic parameter is deliberate so that
 * `implements IOutboxEventsHandler` without a type argument still
 * type-checks against any concrete event shape.
 *
 * @example
 * ```ts
 * @OutboxEventsHandler(OrderPlacedEvent)
 * export class InventoryReservationHandler
 *   implements IOutboxEventsHandler<OrderPlacedEvent>
 * {
 *   async handle(event: OrderPlacedEvent): Promise<void> {
 *     // durable, at-least-once, retried on failure
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IOutboxEventsHandler<T = any> {
  handle(event: T): Promise<void>;
}
