/**
 * Domain event published from `OrderService.placeOrder`. Without
 * `@Externalized` it is delivered in-process: the outbox topic is the
 * class name, `OrderPlacedEvent`, which `ShippingHandler` subscribes to.
 */
export class OrderPlacedEvent {
  constructor(
    public readonly orderId: string,
    public readonly customerEmail: string,
    public readonly totalCents: number,
  ) {}
}
