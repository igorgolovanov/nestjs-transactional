/**
 * Contract implemented by classes annotated with
 * `@TransactionalEventsHandler`.
 *
 * The single `handle` method is invoked for each event of a type the
 * class is registered for. When a handler listens to several event
 * types, narrow the generic parameter to their union (e.g.
 * `ITransactionalEventsHandler<OrderPlaced | OrderCancelled>`) or
 * leave it unbound for the most permissive shape.
 *
 * Mirrors the ergonomics of `IEventHandler` from `@nestjs/cqrs` —
 * `any` as the default generic parameter is deliberate so that
 * `implements ITransactionalEventsHandler` without a type argument
 * type-checks against any concrete event shape.
 *
 * @example
 * ```ts
 * @TransactionalEventsHandler(OrderPlacedEvent)
 * export class OrderPlacedNotifier
 *   implements ITransactionalEventsHandler<OrderPlacedEvent>
 * {
 *   async handle(event: OrderPlacedEvent): Promise<void> {
 *     // ...
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ITransactionalEventsHandler<T = any> {
  handle(event: T): Promise<void> | void;
}
