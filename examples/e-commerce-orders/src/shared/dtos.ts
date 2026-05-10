/**
 * REST contract DTOs. Hand-rolled (no class-validator) so the
 * example stays minimal — production would add validation pipes
 * and OpenAPI decorators.
 */

export interface PlaceOrderItemDto {
  readonly sku: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface PlaceOrderRequestDto {
  readonly customerId: string;
  readonly items: readonly PlaceOrderItemDto[];
}

export interface OrderResponseDto {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
  readonly totalAmountCents: number;
  readonly items: readonly PlaceOrderItemDto[];
  readonly placedAt: string;
  readonly confirmedAt: string | null;
  readonly failureReason: string | null;
}
