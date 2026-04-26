import { EventTypeRegistry } from '../serialization/event-type-registry';
import { JsonEventSerializer } from '../serialization/json-event-serializer';

import {
  AssertablePublishedEvents,
  PublishedEventsAssertionError,
} from './assertable-published-events';
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

describe('AssertablePublishedEvents', () => {
  let repo: InMemoryEventPublicationRepository;
  let serializer: JsonEventSerializer;
  let assertable: AssertablePublishedEvents;

  beforeEach(() => {
    const typeRegistry = new EventTypeRegistry();
    typeRegistry.registerAll([OrderPlacedEvent, OrderShippedEvent]);
    serializer = new JsonEventSerializer(typeRegistry);

    repo = new InMemoryEventPublicationRepository();
    const publishedEvents = new PublishedEvents(repo, serializer);
    assertable = new AssertablePublishedEvents(publishedEvents);
  });

  async function seed(event: object, listenerId = 'L'): Promise<void> {
    await repo.createAll([
      {
        listenerId,
        eventType: event.constructor.name,
        serializedEvent: serializer.serialize(event),
      },
    ]);
  }

  describe('contains', () => {
    it('returns an AssertionView over the matching events', async () => {
      await seed(new OrderPlacedEvent('order-1', 100));
      await seed(new OrderPlacedEvent('order-2', 200));

      const view = await assertable.contains(OrderPlacedEvent);
      expect(view.toArray()).toHaveLength(2);
    });

    it('throws PublishedEventsAssertionError when no events of the type were published', async () => {
      await seed(new OrderShippedEvent('order-1'));

      await expect(assertable.contains(OrderPlacedEvent)).rejects.toBeInstanceOf(
        PublishedEventsAssertionError,
      );
      await expect(assertable.contains(OrderPlacedEvent)).rejects.toThrow(
        /Expected at least one event of type OrderPlacedEvent/,
      );
    });
  });

  describe('doesNotContain', () => {
    it('resolves when no events of the type were published', async () => {
      await seed(new OrderShippedEvent('order-1'));
      await expect(assertable.doesNotContain(OrderPlacedEvent)).resolves.toBeUndefined();
    });

    it('throws PublishedEventsAssertionError when one or more events were published', async () => {
      await seed(new OrderPlacedEvent('order-1', 100));

      await expect(assertable.doesNotContain(OrderPlacedEvent)).rejects.toBeInstanceOf(
        PublishedEventsAssertionError,
      );
      await expect(assertable.doesNotContain(OrderPlacedEvent)).rejects.toThrow(
        /Expected no events of type OrderPlacedEvent, but found 1/,
      );
    });
  });

  describe('AssertionView', () => {
    it('matching(getter, expected) narrows and returns a new view', async () => {
      await seed(new OrderPlacedEvent('order-a', 100));
      await seed(new OrderPlacedEvent('order-b', 250));

      const view = await assertable.contains(OrderPlacedEvent);
      const narrowed = view.matching((e) => e.orderId, 'order-b');

      expect(narrowed.toArray()).toHaveLength(1);
      expect(narrowed.toArray()[0]!.amount).toBe(250);
    });

    it('matching(...) throws when nothing in the view matches', async () => {
      await seed(new OrderPlacedEvent('order-a', 100));

      const view = await assertable.contains(OrderPlacedEvent);
      expect(() => view.matching((e) => e.orderId, 'nonexistent')).toThrow(
        PublishedEventsAssertionError,
      );
    });

    it('hasSize asserts the exact count', async () => {
      await seed(new OrderPlacedEvent('order-a', 100));
      await seed(new OrderPlacedEvent('order-b', 250));

      const view = await assertable.contains(OrderPlacedEvent);
      expect(() => view.hasSize(2)).not.toThrow();
      expect(() => view.hasSize(1)).toThrow(PublishedEventsAssertionError);
      expect(() => view.hasSize(3)).toThrow(/Expected 3 events.*but found 2/);
    });

    it('chains matching + hasSize for readable assertions', async () => {
      await seed(new OrderPlacedEvent('order-a', 100));
      await seed(new OrderPlacedEvent('order-b', 250));
      await seed(new OrderPlacedEvent('order-b', 300), 'L-other');

      const view = await assertable.contains(OrderPlacedEvent);
      expect(() =>
        view.matching((e) => e.orderId, 'order-b').hasSize(2),
      ).not.toThrow();
    });
  });
});
