import type { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';

import {
  HybridEventPublisher,
  type OutboxPublicationScheduler,
} from './hybrid-event-publisher';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

function fakeDispatcher(): TransactionalEventDispatcher {
  const dispatcher = {
    scheduleDispatch: jest.fn(),
  };
  return dispatcher as unknown as TransactionalEventDispatcher;
}

describe('HybridEventPublisher', () => {
  describe('without an outbox scheduler bound', () => {
    it('forwards publish to the in-memory dispatcher only', () => {
      const dispatcher = fakeDispatcher();
      const publisher = new HybridEventPublisher(dispatcher);

      const event = new OrderPlacedEvent('o-1');
      publisher.publish(event);

      expect(dispatcher.scheduleDispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.scheduleDispatch).toHaveBeenCalledWith(event);
    });

    it('publishAll forwards each event to the in-memory dispatcher in order', () => {
      const dispatcher = fakeDispatcher();
      const publisher = new HybridEventPublisher(dispatcher);

      const events = [new OrderPlacedEvent('a'), new OrderPlacedEvent('b'), new OrderPlacedEvent('c')];
      publisher.publishAll(events);

      expect(dispatcher.scheduleDispatch).toHaveBeenCalledTimes(3);
      expect(dispatcher.scheduleDispatch).toHaveBeenNthCalledWith(1, events[0]);
      expect(dispatcher.scheduleDispatch).toHaveBeenNthCalledWith(2, events[1]);
      expect(dispatcher.scheduleDispatch).toHaveBeenNthCalledWith(3, events[2]);
    });
  });

  describe('with an outbox scheduler bound', () => {
    let dispatcher: TransactionalEventDispatcher;
    let outbox: OutboxPublicationScheduler & { scheduleForPublication: jest.Mock };
    let publisher: HybridEventPublisher;

    beforeEach(() => {
      dispatcher = fakeDispatcher();
      outbox = { scheduleForPublication: jest.fn() };
      publisher = new HybridEventPublisher(dispatcher, outbox);
    });

    it('routes every event to both the in-memory dispatcher AND the outbox scheduler', () => {
      const event = new OrderPlacedEvent('o-42');
      publisher.publish(event);

      expect(dispatcher.scheduleDispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.scheduleDispatch).toHaveBeenCalledWith(event);
      expect(outbox.scheduleForPublication).toHaveBeenCalledTimes(1);
      expect(outbox.scheduleForPublication).toHaveBeenCalledWith(event);
    });

    it('publishAll routes every event to both paths in order', () => {
      const events = [new OrderPlacedEvent('x'), new OrderPlacedEvent('y')];
      publisher.publishAll(events);

      expect(dispatcher.scheduleDispatch).toHaveBeenCalledTimes(2);
      expect(outbox.scheduleForPublication).toHaveBeenCalledTimes(2);
      expect(outbox.scheduleForPublication).toHaveBeenNthCalledWith(1, events[0]);
      expect(outbox.scheduleForPublication).toHaveBeenNthCalledWith(2, events[1]);
    });
  });
});
