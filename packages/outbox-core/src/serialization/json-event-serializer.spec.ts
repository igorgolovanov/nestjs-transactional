import { DeserializationError, SerializationError } from '../types/errors';

import { EventTypeRegistry } from './event-type-registry';
import { JsonEventSerializer } from './json-event-serializer';

class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly amount: number,
  ) {}

  // A trivial method to verify prototype restoration after deserialize.
  describe(): string {
    return `Order ${this.orderId} for ${this.amount}`;
  }
}

describe('JsonEventSerializer', () => {
  let registry: EventTypeRegistry;
  let serializer: JsonEventSerializer;

  beforeEach(() => {
    registry = new EventTypeRegistry();
    serializer = new JsonEventSerializer(registry);
  });

  describe('serialize', () => {
    it('encodes a plain event object as a JSON string', () => {
      const event = new OrderPlacedEvent('order-1', 99);

      const result = serializer.serialize(event);

      expect(JSON.parse(result)).toEqual({ orderId: 'order-1', amount: 99 });
    });

    it('throws SerializationError when the payload contains a circular reference', () => {
      const circular: Record<string, unknown> = { name: 'broken' };
      circular.self = circular;

      expect(() => serializer.serialize(circular)).toThrow(SerializationError);
    });

    it('throws SerializationError for non-object inputs', () => {
      expect(() => serializer.serialize(null)).toThrow(SerializationError);
      expect(() => serializer.serialize('plain string')).toThrow(SerializationError);
    });
  });

  describe('deserialize', () => {
    it('restores the class prototype when the event type is registered', () => {
      registry.register(OrderPlacedEvent);

      const payload = JSON.stringify({ orderId: 'order-1', amount: 99 });
      const result = serializer.deserialize(payload, 'OrderPlacedEvent');

      expect(result).toBeInstanceOf(OrderPlacedEvent);
      expect((result as OrderPlacedEvent).orderId).toBe('order-1');
      expect((result as OrderPlacedEvent).amount).toBe(99);
      expect((result as OrderPlacedEvent).describe()).toBe('Order order-1 for 99');
    });

    it('returns a plain object when the event type is not registered', () => {
      const payload = JSON.stringify({ orderId: 'order-1', amount: 99 });
      const result = serializer.deserialize(payload, 'OrderPlacedEvent');

      expect(result).not.toBeInstanceOf(OrderPlacedEvent);
      expect(result).toEqual({ orderId: 'order-1', amount: 99 });
    });

    it('throws DeserializationError for malformed JSON', () => {
      registry.register(OrderPlacedEvent);

      expect(() => serializer.deserialize('not-valid-json', 'OrderPlacedEvent')).toThrow(
        DeserializationError,
      );
    });
  });
});
