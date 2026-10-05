import { Global, Module } from '@nestjs/common';
import { Outbox } from '@nestjs/outbox';
import { Test } from '@nestjs/testing';

import { OutboxEventPublisher } from '../publisher/outbox-event-publisher.js';

import { OUTBOX_PUBLICATION_SCHEDULER } from './tokens.js';
import { TransactionalOutboxModule } from './transactional-outbox.module.js';

@Global()
@Module({
  providers: [{ provide: Outbox, useValue: { add: () => undefined, notify: () => undefined } }],
  exports: [Outbox],
})
class FakeNestOutboxModule {}

describe('TransactionalOutboxModule', () => {
  it('provides the publisher and binds the cqrs scheduler port to it', async () => {
    const app = await Test.createTestingModule({
      imports: [FakeNestOutboxModule, TransactionalOutboxModule.forRoot({ dataSource: 'orders' })],
    }).compile();

    const publisher = app.get(OutboxEventPublisher);
    expect(publisher).toBeInstanceOf(OutboxEventPublisher);
    expect(app.get(OUTBOX_PUBLICATION_SCHEDULER)).toBe(publisher);
  });

  it('shares the scheduler key with @nestjs-transactional/cqrs', () => {
    expect(OUTBOX_PUBLICATION_SCHEDULER).toBe(
      Symbol.for('@nestjs-transactional/cqrs/outbox-publication-scheduler'),
    );
  });
});
