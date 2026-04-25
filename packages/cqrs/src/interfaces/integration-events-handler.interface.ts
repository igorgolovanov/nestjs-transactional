/**
 * Contract implemented by classes annotated with
 * `@IntegrationEventsHandler` — the smart-default decorator for
 * cross-module / cross-service event handlers.
 *
 * The Spring Modulith equivalent is `@ApplicationModuleListener`.
 * The name `@IntegrationEventsHandler` is preferred in the NestJS
 * ecosystem because "Application Module" overlaps with NestJS's own
 * `@Module()` (a DI concept), and "Integration events" is the
 * established DDD/microservices term for the role this decorator
 * plays.
 *
 * Shape is identical to {@link ITransactionalEventsHandler}; the two
 * interfaces exist separately as marker types so code can
 * discriminate by intent (cross-module integration handler vs.
 * intra-module transactional listener) even though both share the
 * `handle(event)` contract.
 *
 * @example
 * ```ts
 * @IntegrationEventsHandler(OrderPlacedEvent)
 * export class InventoryReservationHandler
 *   implements IIntegrationEventsHandler<OrderPlacedEvent>
 * {
 *   async handle(event: OrderPlacedEvent): Promise<void> {
 *     // durable when the outbox is wired, in-memory AFTER_COMMIT
 *     // fallback otherwise.
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface IIntegrationEventsHandler<T = any> {
  handle(event: T): Promise<void> | void;
}
