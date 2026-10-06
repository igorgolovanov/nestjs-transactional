import {
  type Duration,
  Workflow,
  type WorkflowContext,
  type WorkflowRunner,
} from '@nestjs/workflows';
import { StartOn } from '@nestjs/workflows/cqrs';

import { InventoryService } from '../fakes/inventory.service.js';
import { PaymentsService } from '../fakes/payments.service.js';
import { OrderPlaced } from '../orders/events.js';
import { OrdersService } from '../orders/orders.service.js';

import { delivered } from './delivered.signal.js';

/** One fulfilment per order: the order id gives the instance id. */
export const fulfilmentId = (orderId: string): string => `fulfil-${orderId}`;

export interface FulfilmentInput {
  readonly orderId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly amountCents: number;
}

export interface FulfilmentResult {
  readonly chargeId: string;
  readonly carrier: string;
}

/** How long the workflow waits for the delivery before it compensates. */
export const DELIVERY_TIMEOUT: Duration = '1h';

/**
 * Started by `OrderPlaced`, in the transaction that placed the order
 * (`@StartOn` through `WorkflowsCqrsModule`). Each step survives a crash:
 * after a restart the workflow replays from its journal and continues
 * with the first step that did not finish.
 *
 * If a step fails for good, or the delivery never comes, the
 * compensations of the finished steps run in reverse: the stock is
 * released, the charge refunded, the order cancelled.
 */
@StartOn(OrderPlaced, {
  id: (event) => fulfilmentId(event.orderId),
  input: (event): FulfilmentInput => ({
    orderId: event.orderId,
    sku: event.sku,
    quantity: event.quantity,
    amountCents: event.amountCents,
  }),
})
@Workflow('fulfil-order')
export class FulfilOrder implements WorkflowRunner<FulfilmentInput, FulfilmentResult> {
  constructor(
    private readonly payments: PaymentsService,
    private readonly inventory: InventoryService,
    private readonly orders: OrdersService,
  ) {}

  async run(ctx: WorkflowContext, input: FulfilmentInput): Promise<FulfilmentResult> {
    const { chargeId } = await ctx.step(
      'charge-payment',
      ({ idempotencyKey }) =>
        this.payments.charge(input.orderId, input.amountCents, idempotencyKey),
      {
        compensate: async (charge) => {
          await this.payments.refund(charge.chargeId);
          await this.orders.cancel(input.orderId);
        },
      },
    );

    await ctx.step(
      'reserve-stock',
      ({ idempotencyKey }) => this.inventory.reserve(input.sku, input.quantity, idempotencyKey),
      { compensate: (reservation) => this.inventory.release(reservation.reservationId) },
    );

    // `markPaid` is `@Transactional`: the status and the `orders.paid`
    // outbox message commit together, inside this step.
    await ctx.step('mark-paid', () => this.orders.markPaid(input.orderId, chargeId));

    // Parks the instance until the carrier's webhook signals, with no
    // worker or timer held meanwhile.
    const delivery = await ctx.waitForSignal('await-delivery', delivered, {
      key: input.orderId,
      timeout: DELIVERY_TIMEOUT,
    });
    if (delivery === null) {
      ctx.fail(`Order ${input.orderId} was not delivered in time`);
    }

    return { chargeId, carrier: delivery.carrier };
  }
}
