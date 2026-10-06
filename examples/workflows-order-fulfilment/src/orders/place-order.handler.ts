import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { Order } from './order.aggregate.js';
import { OrderEntity } from './order.entity.js';

export class PlaceOrderCommand {
  constructor(
    readonly orderId: string,
    readonly sku: string,
    readonly quantity: number,
    readonly amountCents: number,
    /** Throw after everything is written, to show the rollback. */
    readonly failAfterWriting = false,
  ) {}
}

/**
 * The whole point of the example in one method. Inside this one
 * transaction:
 *
 * 1. the order row is saved;
 * 2. `order.commit()` publishes `OrderPlaced` on the `EventBus`, and
 *    - `WorkflowsCqrsModule` starts `FulfilOrder` for it, in this
 *      transaction, because `TransactionalCqrsModule` put
 *      `{ transaction }` into the dispatcher context;
 *    - the outbox bridge adds it to `@nestjs/outbox`, in this
 *      transaction, because it is `@Externalized`.
 *
 * Nothing here passes a transaction around. If the method throws, the
 * order, the workflow instance and the outbox message all roll back.
 */
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, void> {
  constructor(
    @InjectRepository(OrderEntity) private readonly orders: Repository<OrderEntity>,
    private readonly publisher: EventPublisher,
  ) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<void> {
    await this.orders.save({
      id: command.orderId,
      sku: command.sku,
      quantity: command.quantity,
      amountCents: command.amountCents,
      status: 'placed',
      chargeId: null,
      carrier: null,
    });

    const order = this.publisher.mergeObjectContext(
      new Order(command.orderId, command.sku, command.quantity, command.amountCents),
    );
    order.place();
    order.commit();

    if (command.failAfterWriting) {
      throw new Error(`Order ${command.orderId} failed after writing; everything rolls back`);
    }
  }
}
