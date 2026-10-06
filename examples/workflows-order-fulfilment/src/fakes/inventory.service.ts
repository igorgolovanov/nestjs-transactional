import { Injectable } from '@nestjs/common';
import { NonRetryableStepError } from '@nestjs/workflows';

/** Stands in for a stock service. `out-of-stock` has none, which fails the workflow. */
@Injectable()
export class InventoryService {
  readonly stock = new Map<string, number>([
    ['book', 100],
    ['out-of-stock', 0],
  ]);
  readonly reservations = new Map<string, { sku: string; quantity: number }>();

  async reserve(
    sku: string,
    quantity: number,
    idempotencyKey: string,
  ): Promise<{ reservationId: string }> {
    const reservationId = `res_${idempotencyKey}`;
    if (this.reservations.has(reservationId)) {
      return { reservationId };
    }
    const available = this.stock.get(sku) ?? 0;
    if (available < quantity) {
      // Retrying cannot help: fail the step at once, and with it the
      // workflow, which runs its compensations.
      throw new NonRetryableStepError(`Only ${available} of ${sku} in stock, ${quantity} ordered`);
    }
    this.stock.set(sku, available - quantity);
    this.reservations.set(reservationId, { sku, quantity });
    return { reservationId };
  }

  async release(reservationId: string): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (reservation !== undefined) {
      this.stock.set(
        reservation.sku,
        (this.stock.get(reservation.sku) ?? 0) + reservation.quantity,
      );
      this.reservations.delete(reservationId);
    }
  }
}
