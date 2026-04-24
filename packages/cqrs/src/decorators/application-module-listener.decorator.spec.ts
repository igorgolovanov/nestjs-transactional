import {
  OUTBOX_EVENT_LISTENER_METADATA,
  getOutboxEventListenerMetadata,
} from '@nestjs-transactional/outbox-core';

import {
  TRANSACTIONAL_EVENTS_LISTENER_METADATA,
  TransactionPhase,
  type TransactionalEventsListenerMetadata,
} from '../types/transactional-listener.types';

import {
  ApplicationModuleListener,
  hasOutboxListenerMetadata,
} from './application-module-listener.decorator';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

class InventoryHandlers {
  @ApplicationModuleListener(OrderPlacedEvent)
  async onOrderPlaced(_event: OrderPlacedEvent): Promise<void> {}

  @ApplicationModuleListener(OrderPlacedEvent, { id: 'Inventory.stable-id' })
  async onOrderPlacedStable(_event: OrderPlacedEvent): Promise<void> {}

  plainMethod(): void {}
}

function methodOf(instance: InventoryHandlers, name: keyof InventoryHandlers): object {
  return instance[name];
}

describe('ApplicationModuleListener decorator', () => {
  const inventory = new InventoryHandlers();

  it('writes outbox listener metadata with newTransaction: true and the supplied event type', () => {
    const outboxMeta = getOutboxEventListenerMetadata(methodOf(inventory, 'onOrderPlaced'));

    expect(outboxMeta).toBeDefined();
    expect(outboxMeta?.eventType).toBe(OrderPlacedEvent);
    expect(outboxMeta?.newTransaction).toBe(true);
    expect(outboxMeta?.id).toBeUndefined();
  });

  it('writes in-memory listener metadata with phase AFTER_COMMIT and async: true', () => {
    const transactionalMeta = Reflect.getMetadata(
      TRANSACTIONAL_EVENTS_LISTENER_METADATA,
      methodOf(inventory, 'onOrderPlaced'),
    ) as TransactionalEventsListenerMetadata | undefined;

    expect(transactionalMeta).toBeDefined();
    expect(transactionalMeta?.eventType).toBe(OrderPlacedEvent);
    expect(transactionalMeta?.phase).toBe(TransactionPhase.AFTER_COMMIT);
    expect(transactionalMeta?.async).toBe(true);
    expect(transactionalMeta?.fallbackExecution).toBe(false);
  });

  it('propagates an explicit id to the outbox metadata', () => {
    const outboxMeta = getOutboxEventListenerMetadata(
      methodOf(inventory, 'onOrderPlacedStable'),
    );

    expect(outboxMeta?.id).toBe('Inventory.stable-id');
  });

  it('writes under the shared Symbol.for key — cqrs and outbox-core see the same metadata', () => {
    const keyFromCqrs = Symbol.for('@nestjs-transactional/outbox-event-listener-metadata');
    // Same-value symbol lookups resolve to the same key identity.
    expect(keyFromCqrs).toBe(OUTBOX_EVENT_LISTENER_METADATA);

    const outboxMeta = Reflect.getMetadata(keyFromCqrs, methodOf(inventory, 'onOrderPlaced'));
    expect(outboxMeta).toBeDefined();
  });

  it('hasOutboxListenerMetadata returns true for decorated methods and false otherwise', () => {
    expect(hasOutboxListenerMetadata(methodOf(inventory, 'onOrderPlaced'))).toBe(true);
    expect(hasOutboxListenerMetadata(methodOf(inventory, 'plainMethod'))).toBe(false);
  });
});
