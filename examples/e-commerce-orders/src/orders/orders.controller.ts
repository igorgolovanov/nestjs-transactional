import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';

import type { OrderResponseDto, PlaceOrderRequestDto } from '../shared/dtos';
import { GetOrderHandler, GetOrderQuery } from './get-order.handler';
import { PlaceOrderCommand, PlaceOrderHandler } from './place-order.handler';

/**
 * REST surface — the production-realism bit Tier 5 introduces over
 * Tier 4. Validation is intentionally minimal (a single guard on
 * the items array shape) so the example stays focused on the
 * transactional / saga / outbox / externalization mechanics.
 *
 * **Why inject handlers directly instead of `CommandBus`/`QueryBus`?**
 * Convention #6 forbids importing `@nestjs/cqrs`'s `CqrsModule`
 * alongside `CqrsTransactionalModule` at the same module level —
 * the duplicate `CqrsModule` shadows the `EventPublisher` override
 * and aggregate events bypass the dispatcher. `CommandBus` and
 * `QueryBus` are exported by `CqrsModule` (not by
 * `CqrsTransactionalModule`); without bringing `CqrsModule` into
 * scope, they aren't visible to `OrdersController`. Direct handler
 * injection sidesteps the trade-off — the controller stays thin
 * and the cqrs decorators (`@CommandHandler`, `@QueryHandler`) still
 * apply for handler-bootstrap wrapping by `CqrsTransactionalModule`.
 */
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly placeOrderHandler: PlaceOrderHandler,
    private readonly getOrderHandler: GetOrderHandler,
  ) {}

  @Post()
  @HttpCode(201)
  async placeOrder(
    @Body() body: PlaceOrderRequestDto,
  ): Promise<{ orderId: string }> {
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

    const orderId = await this.placeOrderHandler.execute(
      new PlaceOrderCommand(body.customerId, body.items),
    );
    return { orderId };
  }

  @Get(':id')
  async getOrder(@Param('id') id: string): Promise<OrderResponseDto> {
    return this.getOrderHandler.execute(new GetOrderQuery(id));
  }
}
