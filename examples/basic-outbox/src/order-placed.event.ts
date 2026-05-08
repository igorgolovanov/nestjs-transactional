/**
 * Domain event published from `OrderService.placeOrder` and consumed by
 * `ShippingHandler`. The class is registered with
 * `OutboxModule.forFeature([OrderPlacedEvent])` so the outbox knows how
 * to (de)serialize it across the publish/process boundary.
 */
export class OrderPlacedEvent {
  constructor(
    public readonly orderId: string,
    public readonly customerEmail: string,
  ) {}
}
