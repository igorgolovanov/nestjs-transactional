import type { IApplicationModuleHandler } from '../interfaces/application-module-handler.interface';

import {
  APPLICATION_MODULE_HANDLER_METADATA,
  ApplicationModuleHandler,
  getApplicationModuleHandlerMetadata,
} from './application-module-handler.decorator';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class OrderCancelledEvent {
  constructor(readonly orderId: string) {}
}

describe('@ApplicationModuleHandler', () => {
  describe('rest-params short form', () => {
    it('writes metadata with a single event type and no id', () => {
      @ApplicationModuleHandler(OrderPlacedEvent)
      class Handler implements IApplicationModuleHandler<OrderPlacedEvent> {
        async handle(_event: OrderPlacedEvent): Promise<void> {}
      }

      const metadata = getApplicationModuleHandlerMetadata(Handler);
      expect(metadata).toBeDefined();
      expect(metadata?.eventTypes).toEqual([OrderPlacedEvent]);
      expect(metadata?.id).toBeUndefined();
    });

    it('accepts multiple event types', () => {
      @ApplicationModuleHandler(OrderPlacedEvent, OrderCancelledEvent)
      class Handler implements IApplicationModuleHandler<OrderPlacedEvent | OrderCancelledEvent> {
        async handle(_event: OrderPlacedEvent | OrderCancelledEvent): Promise<void> {}
      }

      const metadata = getApplicationModuleHandlerMetadata(Handler);
      expect(metadata?.eventTypes).toEqual([OrderPlacedEvent, OrderCancelledEvent]);
    });
  });

  describe('options long form', () => {
    it('preserves the explicit id', () => {
      @ApplicationModuleHandler({ events: [OrderPlacedEvent], id: 'Shipping.createShipment' })
      class Handler implements IApplicationModuleHandler<OrderPlacedEvent> {
        async handle(_event: OrderPlacedEvent): Promise<void> {}
      }

      const metadata = getApplicationModuleHandlerMetadata(Handler);
      expect(metadata?.id).toBe('Shipping.createShipment');
      expect(metadata?.eventTypes).toEqual([OrderPlacedEvent]);
    });
  });

  describe('validation', () => {
    it('throws when called with no event types', () => {
      expect(() => ApplicationModuleHandler()).toThrow(/at least one event type/);
    });

    it('throws when called with an empty events array', () => {
      expect(() => ApplicationModuleHandler({ events: [] })).toThrow(
        /at least one event type/,
      );
    });
  });

  describe('metadata key', () => {
    it('is a unique (fresh) Symbol, not shared with outbox-core', () => {
      // Symbol (not Symbol.for) — unique per process identity.
      expect(APPLICATION_MODULE_HANDLER_METADATA.description).toBe(
        'APPLICATION_MODULE_HANDLER_METADATA',
      );
    });
  });

  it('getApplicationModuleHandlerMetadata returns undefined for undecorated classes', () => {
    class PlainClass {}
    expect(getApplicationModuleHandlerMetadata(PlainClass)).toBeUndefined();
  });
});
