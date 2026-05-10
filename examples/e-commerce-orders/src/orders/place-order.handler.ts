import { randomUUID } from 'node:crypto';

import { CommandHandler, EventPublisher, type ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { Order } from './order.aggregate';
import { OrderRow } from './order.entity';

export class PlaceOrderCommand {
  constructor(
    readonly customerId: string,
    readonly items: readonly { sku: string; quantity: number; unitPriceCents: number }[],
  ) {}
}

/**
 * Saga entry point. `@Transactional()` opens the **orders** DS
 * transaction (default DS); `aggregate.commit()` routes
 * `OrderPlacedEvent` through `HybridEventPublisher` which fans it
 * to both the in-memory dispatcher AND the orders DS outbox in one
 * commit (DD-019).
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
