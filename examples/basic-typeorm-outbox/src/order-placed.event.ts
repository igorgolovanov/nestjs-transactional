/**
 * Domain event published from `OrderService.placeOrder`. The class is
 * registered with `OutboxModule.forFeature([OrderPlacedEvent])` so the
 * outbox can serialize it to the `event_publication` table and
 * deserialize on the worker side.
 */
export class OrderPlacedEvent {
  constructor(
    public readonly orderId: string,
    public readonly customerEmail: string,
    public readonly totalCents: number,
  ) {}
}
