import { OutboxListenerRegistry } from '../registry/listener-registry';
import { EventTypeRegistry } from '../serialization/event-type-registry';
import { JsonEventSerializer } from '../serialization/json-event-serializer';
import { PublicationStatus } from '../types/publication-status';

import { InMemoryEventPublicationRepository } from './in-memory-repository';
import { PublishedEvents } from './published-events';

class OrderPlacedEvent {
  constructor(
    readonly orderId: string,
    readonly amount: number,
  ) {}
}

class OrderShippedEvent {
  constructor(readonly orderId: string) {}
}

describe('PublishedEvents', () => {
  let repo: InMemoryEventPublicationRepository;
  let serializer: JsonEventSerializer;
  let listenerRegistry: OutboxListenerRegistry;
  let publishedEvents: PublishedEvents;

  beforeEach(async () => {
    const typeRegistry = new EventTypeRegistry();
    typeRegistry.registerAll([OrderPlacedEvent, OrderShippedEvent]);
    serializer = new JsonEventSerializer(typeRegistry);

    repo = new InMemoryEventPublicationRepository();
    listenerRegistry = new OutboxListenerRegistry();
    publishedEvents = new PublishedEvents(repo, serializer);

    // Seed listeners and publications directly through the repo —
    // keeps the test focused on the utility under test.
    listenerRegistry.register({
      id: 'L-placed',
      eventType: 'OrderPlacedEvent',
      invoke: async () => undefined,
    });
    listenerRegistry.register({
      id: 'L-shipped',
      eventType: 'OrderShippedEvent',
      invoke: async () => undefined,
    });

    const placedA = new OrderPlacedEvent('order-a', 100);
    const placedB = new OrderPlacedEvent('order-b', 250);
    const shipped = new OrderShippedEvent('order-a');

    await repo.createAll([
      {
        listenerId: 'L-placed',
        eventType: OrderPlacedEvent.name,
        serializedEvent: serializer.serialize(placedA),
      },
      {
        listenerId: 'L-placed',
        eventType: OrderPlacedEvent.name,
        serializedEvent: serializer.serialize(placedB),
      },
      {
        listenerId: 'L-shipped',
        eventType: OrderShippedEvent.name,
        serializedEvent: serializer.serialize(shipped),
      },
    ]);
  });

  it('all() returns every stored event regardless of status', async () => {
    const events = await publishedEvents.all();
    expect(events).toHaveLength(3);
    const types = events.map((e) => (e as object).constructor.name).sort();
    expect(types).toEqual(['OrderPlacedEvent', 'OrderPlacedEvent', 'OrderShippedEvent']);
  });

  it('all() includes both incomplete and completed publications', async () => {
    // Mark one of the OrderPlaced rows COMPLETED.
    const [first] = repo.getAll();
    await repo.updateStatus(first!.id, PublicationStatus.COMPLETED, {
      completionDate: new Date(),
    });

    const events = await publishedEvents.all();
    expect(events).toHaveLength(3);
  });

  it('ofType(...) narrows to events of the requested class', async () => {
    const placed = await publishedEvents.ofType(OrderPlacedEvent).get();
    expect(placed).toHaveLength(2);
    expect(placed.every((e) => e instanceof OrderPlacedEvent)).toBe(true);

    const shipped = await publishedEvents.ofType(OrderShippedEvent).get();
    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toBeInstanceOf(OrderShippedEvent);
  });

  it('matching(predicate) applies a boolean filter', async () => {
    const bigOrders = await publishedEvents
      .ofType(OrderPlacedEvent)
      .matching((e) => e.amount >= 200)
      .get();

    expect(bigOrders).toHaveLength(1);
    expect(bigOrders[0]!.orderId).toBe('order-b');
  });

  it('matching(getter, expected) applies an equality filter', async () => {
    const specificOrder = await publishedEvents
      .ofType(OrderPlacedEvent)
      .matching((e) => e.orderId, 'order-a')
      .get();

    expect(specificOrder).toHaveLength(1);
    expect(specificOrder[0]!.amount).toBe(100);
  });

  it('matching() is conjunctive — multiple predicates AND together', async () => {
    const precise = await publishedEvents
      .ofType(OrderPlacedEvent)
      .matching((e) => e.amount >= 100)
      .matching((e) => e.orderId, 'order-b')
      .get();

    expect(precise).toHaveLength(1);
    expect(precise[0]!.orderId).toBe('order-b');
  });

  it('count() returns the number of matching events', async () => {
    const total = await publishedEvents.ofType(OrderPlacedEvent).count();
    expect(total).toBe(2);

    const filtered = await publishedEvents
      .ofType(OrderPlacedEvent)
      .matching((e) => e.orderId, 'order-a')
      .count();
    expect(filtered).toBe(1);

    const none = await publishedEvents
      .ofType(OrderPlacedEvent)
      .matching((e) => e.amount > 10_000)
      .count();
    expect(none).toBe(0);
  });
});
