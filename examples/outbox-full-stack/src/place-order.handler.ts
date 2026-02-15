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

/**
 * Command handler. `@Transactional()` opens a transaction and
 * `order.commit()` fans the emitted OrderPlacedEvent out to BOTH the
 * in-memory dispatcher (phase-aware listeners) AND the outbox
 * (durable listeners). Both paths commit / roll back atomically with
 * the business write.
 */
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
    order.commit();

    if (command.shouldFail) {
      throw new Error('simulated failure — transaction will roll back');
    }
  }
}
