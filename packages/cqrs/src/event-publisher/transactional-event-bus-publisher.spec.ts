import { jest } from '@jest/globals';
import type { IEventPublisher } from '@nestjs/cqrs';

import type { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher.js';

import type { OutboxPublicationScheduler } from './outbox-publication-scheduler.js';
import { TransactionalEventBusPublisher } from './transactional-event-bus-publisher.js';

class First {}
class Second {}

function collaborators(): {
  log: string[];
  dispatcher: TransactionalEventDispatcher;
  outbox: OutboxPublicationScheduler;
  inner: IEventPublisher;
} {
  const log: string[] = [];
  const name = (event: unknown): string => (event as object).constructor.name;
  return {
    log,
    dispatcher: {
      scheduleDispatch: (event: object) => log.push(`phase ${name(event)}`),
    } as unknown as TransactionalEventDispatcher,
    outbox: { scheduleForPublication: (event) => void log.push(`outbox ${name(event)}`) },
    inner: { publish: (event) => void log.push(`inner ${name(event)}`) },
  };
}

describe('TransactionalEventBusPublisher', () => {
  it('schedules phases, then the outbox, then hands the event on', () => {
    const { log, dispatcher, outbox, inner } = collaborators();
    const publisher = new TransactionalEventBusPublisher();
    publisher.attach({ dispatcher, outbox, inner });

    publisher.publish(new First());

    expect(log).toEqual(['phase First', 'outbox First', 'inner First']);
  });

  it('works without an outbox', () => {
    const { log, dispatcher, inner } = collaborators();
    const publisher = new TransactionalEventBusPublisher();
    publisher.attach({ dispatcher, inner });

    publisher.publish(new First());

    expect(log).toEqual(['phase First', 'inner First']);
  });

  it('publishAll keeps the events in order, each through every step', () => {
    const { log, dispatcher, inner } = collaborators();
    const publisher = new TransactionalEventBusPublisher();
    publisher.attach({ dispatcher, inner });

    publisher.publishAll([new First(), new Second()]);

    expect(log).toEqual(['phase First', 'inner First', 'phase Second', 'inner Second']);
  });

  it('passes the dispatcher and async contexts on to the inner publisher', () => {
    const { dispatcher } = collaborators();
    const publish = jest.fn();
    const publisher = new TransactionalEventBusPublisher();
    publisher.attach({ dispatcher, inner: { publish } });
    const context = { transaction: 'tx' };
    const asyncContext = { id: 'request' };

    publisher.publish(new First(), context, asyncContext);

    expect(publish).toHaveBeenCalledWith(expect.any(First), context, asyncContext);
  });

  it("returns the inner publisher's promises, so a caller or the bus can await them", async () => {
    const { dispatcher } = collaborators();
    const publisher = new TransactionalEventBusPublisher();
    publisher.attach({ dispatcher, inner: { publish: () => Promise.resolve('done') } });

    await expect(publisher.publish(new First())).resolves.toBe('done');
    await expect(publisher.publishAll([new First(), new Second()])).resolves.toEqual([
      'done',
      'done',
    ]);
  });

  it('exposes the delegate it was built with, and the inner publisher once attached', () => {
    const { dispatcher, inner } = collaborators();
    const publisher = new TransactionalEventBusPublisher(inner);

    expect(publisher.delegate).toBe(inner);
    expect(publisher.inner).toBeUndefined();
    publisher.attach({ dispatcher, inner });
    expect(publisher.inner).toBe(inner);
  });

  it('refuses events before it is attached, saying why', () => {
    const publisher = new TransactionalEventBusPublisher();

    expect(() => publisher.publish(new First())).toThrow(/before CqrsTransactionalModule/);
  });
});
