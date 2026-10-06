import { Injectable } from '@nestjs/common';

/**
 * Stands in for a payment provider's SDK. Like a real one, it
 * deduplicates by idempotency key, so a retried workflow step charges
 * once.
 */
@Injectable()
export class PaymentsService {
  readonly charges = new Map<string, { orderId: string; amountCents: number; refunded: boolean }>();

  async charge(
    orderId: string,
    amountCents: number,
    idempotencyKey: string,
  ): Promise<{ chargeId: string }> {
    const chargeId = `ch_${idempotencyKey}`;
    if (!this.charges.has(chargeId)) {
      this.charges.set(chargeId, { orderId, amountCents, refunded: false });
    }
    return { chargeId };
  }

  async refund(chargeId: string): Promise<void> {
    const charge = this.charges.get(chargeId);
    if (charge !== undefined) {
      charge.refunded = true;
    }
  }
}
