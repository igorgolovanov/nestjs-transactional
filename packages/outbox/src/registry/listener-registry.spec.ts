import { DuplicateListenerIdError } from '../types/errors';

import { OutboxListenerRegistry, type RegisteredOutboxListener } from './listener-registry';

function listener(
  id: string,
  eventType: string,
  invoke: (event: unknown) => Promise<void> = async () => {},
): RegisteredOutboxListener {
  return { id, eventType, invoke };
}

describe('OutboxListenerRegistry', () => {
  let registry: OutboxListenerRegistry;

  beforeEach(() => {
    registry = new OutboxListenerRegistry();
  });

  it('returns a registered listener by its event type', () => {
    const a = listener('Inventory.onOrderPlaced', 'OrderPlacedEvent');
    registry.register(a);

    expect(registry.getByEventType('OrderPlacedEvent')).toEqual([a]);
  });

  it('throws DuplicateListenerIdError when registering a second listener with the same id', () => {
    const first = listener('dup', 'EventA');
    const second = listener('dup', 'EventB');
    registry.register(first);

    expect(() => registry.register(second)).toThrow(DuplicateListenerIdError);
    expect(() => registry.register(second)).toThrow(/'dup'/);
  });

  it('returns every listener subscribed to a single event type in registration order', () => {
    const a = listener('a', 'OrderPlaced');
    const b = listener('b', 'OrderPlaced');
    const c = listener('c', 'OrderPlaced');
    registry.register(a);
    registry.register(b);
    registry.register(c);

    expect(registry.getByEventType('OrderPlaced')).toEqual([a, b, c]);
  });

  it('returns an empty array for an unknown event type', () => {
    expect(registry.getByEventType('Unknown')).toEqual([]);
  });

  it('getById returns the listener or undefined', () => {
    const a = listener('a', 'E');
    registry.register(a);

    expect(registry.getById('a')).toBe(a);
    expect(registry.getById('missing')).toBeUndefined();
  });

  it('getAll returns every registered listener', () => {
    const a = listener('a', 'E1');
    const b = listener('b', 'E2');
    const c = listener('c', 'E1');
    registry.register(a);
    registry.register(b);
    registry.register(c);

    expect(registry.getAll()).toEqual([a, b, c]);
  });

  it('clear empties both indexes and allows the same id to be re-registered', () => {
    registry.register(listener('a', 'E1'));
    registry.register(listener('b', 'E2'));

    registry.clear();

    expect(registry.getAll()).toEqual([]);
    expect(registry.getByEventType('E1')).toEqual([]);
    expect(registry.getById('a')).toBeUndefined();

    const replacement = listener('a', 'E1');
    expect(() => registry.register(replacement)).not.toThrow();
    expect(registry.getById('a')).toBe(replacement);
  });
});
