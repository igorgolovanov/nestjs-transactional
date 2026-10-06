import { AggregateRoot } from '@nestjs/cqrs';

import { OrderPlaced } from './events.js';

export class Order extends AggregateRoot {
  constructor(
    readonly id: string,
    readonly sku: string,
    readonly quantity: number,
    readonly amountCents: number,
  ) {
    super();
  }

  place(): void {
    this.apply(new OrderPlaced(this.id, this.sku, this.quantity, this.amountCents));
  }
}
