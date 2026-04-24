import { AggregateRoot } from '@nestjs/cqrs';

export class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

export class Order extends AggregateRoot {
  status = 'pending';

  constructor(readonly id: string) {
    super();
  }

  place(): void {
    this.status = 'placed';
    this.apply(new OrderPlacedEvent(this.id));
  }
}
