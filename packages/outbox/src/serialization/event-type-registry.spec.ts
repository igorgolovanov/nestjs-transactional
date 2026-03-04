import { EventTypeRegistry } from './event-type-registry';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class OrderShippedEvent {
  constructor(readonly orderId: string) {}
}

describe('EventTypeRegistry', () => {
  let registry: EventTypeRegistry;

  beforeEach(() => {
    registry = new EventTypeRegistry();
  });

  it('register / get / has / getOrThrow work on a registered class', () => {
    registry.register(OrderPlacedEvent);

    expect(registry.has('OrderPlacedEvent')).toBe(true);
    expect(registry.get('OrderPlacedEvent')).toBe(OrderPlacedEvent);
    expect(registry.getOrThrow('OrderPlacedEvent')).toBe(OrderPlacedEvent);
  });

  it('get returns undefined and has returns false for unregistered types', () => {
    expect(registry.get('NothingRegistered')).toBeUndefined();
    expect(registry.has('NothingRegistered')).toBe(false);
  });

  it('registerAll registers every class in the array', () => {
    registry.registerAll([OrderPlacedEvent, OrderShippedEvent]);

    expect(registry.get('OrderPlacedEvent')).toBe(OrderPlacedEvent);
    expect(registry.get('OrderShippedEvent')).toBe(OrderShippedEvent);
  });

  it('getOrThrow throws with an actionable, informative message', () => {
    expect(() => registry.getOrThrow('UnknownEvent')).toThrow(
      /Event type 'UnknownEvent' not registered/,
    );
    expect(() => registry.getOrThrow('UnknownEvent')).toThrow(
      /OutboxModule\.forFeature/,
    );
  });

  it('register throws on duplicate registration with a clear, actionable message', () => {
    registry.register(OrderPlacedEvent);

    expect(() => registry.register(OrderPlacedEvent)).toThrow(
      /Event type 'OrderPlacedEvent' already registered/,
    );
    expect(() => registry.register(OrderPlacedEvent)).toThrow(
      /OutboxModule\.forFeature/,
    );
  });

  it('registerAll surfaces the duplicate-throw when a single array contains the same class twice', () => {
    expect(() => registry.registerAll([OrderPlacedEvent, OrderPlacedEvent])).toThrow(
      /Event type 'OrderPlacedEvent' already registered/,
    );
  });

  it('getAll returns an independent snapshot — external mutations do not leak in', () => {
    registry.register(OrderPlacedEvent);
    const snapshot = registry.getAll();

    snapshot.delete('OrderPlacedEvent');

    expect(registry.has('OrderPlacedEvent')).toBe(true);
  });
});
