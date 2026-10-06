import { WorkflowSignal } from '@nestjs/workflows';

/** Sent by the carrier's webhook; the fulfilment workflow waits for it, keyed by order id. */
export const delivered = new WorkflowSignal<{ readonly carrier: string }>('order.delivered');
