import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';

import type { OrderResponseDto, PlaceOrderRequestDto } from '../shared/dtos.js';
import { GetOrderQuery } from './get-order.handler.js';
import { PlaceOrderCommand } from './place-order.handler.js';

/**
 * REST surface — the production-realism bit Tier 5 introduces over
 * Tier 4. Validation is intentionally minimal (a single guard on
 * the items array shape) so the example stays focused on the
 * transactional / saga / outbox / externalization mechanics.
 *
 * Commands and queries go through `CommandBus` and `QueryBus`, which
 * `TransactionalCqrsModule` makes injectable everywhere: it imports the
 * global `CqrsModule.forRoot()` itself (convention #6).
 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  @HttpCode(201)
  async placeOrder(@Body() body: PlaceOrderRequestDto): Promise<{ orderId: string }> {
    if (!body?.customerId || !Array.isArray(body.items) || body.items.length === 0) {
      throw new BadRequestException('customerId and non-empty items[] are required');
    }
    for (const item of body.items) {
      if (
        !item?.sku ||
        typeof item.quantity !== 'number' ||
        item.quantity <= 0 ||
        typeof item.unitPriceCents !== 'number' ||
        item.unitPriceCents < 0
      ) {
        throw new BadRequestException(
          'each item needs sku, positive quantity, non-negative unitPriceCents',
        );
      }
    }

    const orderId = await this.commandBus.execute<PlaceOrderCommand, string>(
      new PlaceOrderCommand(body.customerId, body.items),
    );
    return { orderId };
  }

  @Get(':id')
  async getOrder(@Param('id') id: string): Promise<OrderResponseDto> {
    return this.queryBus.execute<GetOrderQuery, OrderResponseDto>(new GetOrderQuery(id));
  }
}
