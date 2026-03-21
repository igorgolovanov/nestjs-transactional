import type { IIntegrationEventHandler } from '../interfaces/integration-event-handler.interface';

import {
  INTEGRATION_EVENTS_HANDLER_METADATA,
  IntegrationEventsHandler,
  getIntegrationEventsHandlerMetadata,
} from './integration-events-handler.decorator';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class OrderCancelledEvent {
  constructor(readonly orderId: string) {}
}

describe('@IntegrationEventsHandler', () => {
  describe('rest-params short form', () => {
    it('writes metadata with a single event type and no id', () => {
      @IntegrationEventsHandler(OrderPlacedEvent)
      class Handler implements IIntegrationEventHandler<OrderPlacedEvent> {
        async handle(_event: OrderPlacedEvent): Promise<void> {}
      }

      const metadata = getIntegrationEventsHandlerMetadata(Handler);
      expect(metadata).toBeDefined();
      expect(metadata?.eventTypes).toEqual([OrderPlacedEvent]);
      expect(metadata?.id).toBeUndefined();
    });

    it('accepts multiple event types', () => {
      @IntegrationEventsHandler(OrderPlacedEvent, OrderCancelledEvent)
      class Handler implements IIntegrationEventHandler<OrderPlacedEvent | OrderCancelledEvent> {
        async handle(_event: OrderPlacedEvent | OrderCancelledEvent): Promise<void> {}
      }

      const metadata = getIntegrationEventsHandlerMetadata(Handler);
      expect(metadata?.eventTypes).toEqual([OrderPlacedEvent, OrderCancelledEvent]);
    });
  });

  describe('options long form', () => {
    it('preserves the explicit id', () => {
      @IntegrationEventsHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
      class Handler implements IIntegrationEventHandler<OrderPlacedEvent> {
        async handle(_event: OrderPlacedEvent): Promise<void> {}
      }

      const metadata = getIntegrationEventsHandlerMetadata(Handler);
      expect(metadata?.id).toBe('Shipping.createShipment');
      expect(metadata?.eventTypes).toEqual([OrderPlacedEvent]);
    });
  });

  describe('validation', () => {
    it('throws when called with no event types', () => {
      expect(() => IntegrationEventsHandler()).toThrow(/at least one event type/);
    });

    it('throws when called with an empty events array', () => {
      expect(() => IntegrationEventsHandler({ events: [] })).toThrow(
        /at least one event type/,
      );
    });
  });

  describe('metadata key', () => {
    it('is a unique (fresh) Symbol, not shared with outbox', () => {
      // Symbol (not Symbol.for) — unique per process identity.
      expect(INTEGRATION_EVENTS_HANDLER_METADATA.description).toBe(
        'INTEGRATION_EVENTS_HANDLER_METADATA',
      );
    });
  });

  it('getIntegrationEventsHandlerMetadata returns undefined for undecorated classes', () => {
    class PlainClass {}
    expect(getIntegrationEventsHandlerMetadata(PlainClass)).toBeUndefined();
  });
});
