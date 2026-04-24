/**
 * Contract implemented by classes annotated with
 * `@ApplicationModuleHandler` — the Spring Modulith-equivalent
 * smart-default decorator for cross-module integration handlers.
 *
 * Shape is identical to {@link ITransactionalEventsHandler}; the two
 * interfaces exist separately as marker types so code can discriminate
 * by intent (module boundary handler vs. intra-module transactional
 * listener) even though both share the `handle(event)` contract.
 *
 * @example
 * ```ts
 * @ApplicationModuleHandler(OrderPlacedEvent)
 * export class InventoryReservationHandler
 *   implements IApplicationModuleHandler<OrderPlacedEvent>
 * {
 *   async handle(event: OrderPlacedEvent): Promise<void> {
 *     // durable when the outbox is wired, in-memory AFTER_COMMIT
 *     // fallback otherwise.
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IApplicationModuleHandler<T = any> {
  handle(event: T): Promise<void> | void;
}
