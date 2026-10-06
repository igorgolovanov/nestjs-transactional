import { Workflow, type WorkflowContext, type WorkflowRunner } from '@nestjs/workflows';

import { ShippingService } from './shipping.service.js';

export const shippingId = (orderId: string): string => `ship-${orderId}`;

export interface ShipOrderInput {
  readonly orderId: string;
}

/**
 * Durable: the worker runs it after the order commits, and a crash
 * between the steps resumes at the step that did not finish.
 */
@Workflow('ship-order')
export class ShipOrder implements WorkflowRunner<ShipOrderInput, string> {
  constructor(private readonly shipping: ShippingService) {}

  async run(ctx: WorkflowContext, input: ShipOrderInput): Promise<string> {
    const trackingNumber = await ctx.step('book-courier', () =>
      this.shipping.bookCourier(input.orderId),
    );
    await ctx.step('mark-shipped', () => this.shipping.markShipped(input.orderId, trackingNumber));
    return trackingNumber;
  }
}
