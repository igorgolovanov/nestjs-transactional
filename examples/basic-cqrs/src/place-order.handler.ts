import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { Transactional } from '@nestjs-transactional/core';

import { Order } from './order.aggregate';

export class PlaceOrderCommand {
  constructor(
    public readonly orderId: string,
    public readonly shouldFail = false,
  ) {}
}

/**
 * `@CommandHandler` classes are wrapped at bootstrap by
 * `CqrsHandlerWrapper` (cqrs package's `OnApplicationBootstrap`):
 * `execute()` is decorated with `@Transactional()`, so the entire
 * command runs in a transaction.
 *
 * `EventPublisher.mergeObjectContext` retargets `aggregate.commit()`
 * through `TransactionalEventPublisher` — buffered events become
 * AFTER_COMMIT hooks instead of an immediate dispatch.
 */
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, void> {
  constructor(private readonly publisher: EventPublisher) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<void> {
    const order = this.publisher.mergeObjectContext(new Order(command.orderId));
    order.place();
    order.commit(); // schedules OrderPlacedEvent on the AFTER_COMMIT hook list

    if (command.shouldFail) {
      throw new Error('simulated failure — transaction rolls back, AFTER_COMMIT skipped');
    }
  }
}
