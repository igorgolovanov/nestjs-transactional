import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { Transactional } from '@nestjs-transactional/core';

import { Order } from './order.aggregate';
import { OrderRepository } from './order.repository';

export class PlaceOrderCommand {
  constructor(
    readonly orderId: string,
    readonly shouldFail = false,
  ) {}
}

@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, void> {
  constructor(
    private readonly publisher: EventPublisher,
    private readonly repo: OrderRepository,
  ) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order(command.orderId));
    order.place();
    await this.repo.save(order);

    // Emits OrderPlacedEvent through the transactional publisher, which
    // registers it as an AFTER_COMMIT hook on the current tx. The hook
    // fires only after the DB commit succeeds.
    order.commit();

    if (command.shouldFail) {
      throw new Error('simulated failure — transaction will roll back');
    }
  }
}
