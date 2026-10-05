import { randomUUID } from 'node:crypto';

import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { Order } from './order.aggregate.js';
import { OrderRow } from './order.entity.js';

export class PlaceOrderCommand {
  constructor(
    readonly customerId: string,
    readonly items: readonly { sku: string; quantity: number; unitPriceCents: number }[],
  ) {}
}

/**
 * Saga entry point. `@Transactional()` opens the transaction;
 * `aggregate.commit()` publishes `OrderPlacedEvent` on the `EventBus`,
 * whose transactional publisher hands it to the in-memory dispatcher
 * and, because it is `@Externalized`, adds it to the outbox in the same
 * transaction as the order row.
 *
 * Returns the new `orderId` so the controller can include it in the
 * 201 response Location header.
 */
@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand, string> {
  constructor(
    @InjectRepository(OrderRow)
    private readonly orders: Repository<OrderRow>,
    private readonly publisher: EventPublisher,
  ) {}

  @Transactional()
  async execute(command: PlaceOrderCommand): Promise<string> {
    const orderId = `ord-${randomUUID().slice(0, 8)}`;
    const totalCents = command.items.reduce(
      (sum, item) => sum + item.quantity * item.unitPriceCents,
      0,
    );

    await this.orders.insert({
      id: orderId,
      customerId: command.customerId,
      status: 'placed',
      totalAmountCents: totalCents,
      items: [...command.items],
      placedAt: new Date(),
      confirmedAt: null,
      failureReason: null,
    });

    const order = this.publisher.mergeObjectContext(
      new Order(orderId, command.customerId, command.items, totalCents),
    );
    order.place();
    order.commit();

    return orderId;
  }
}
