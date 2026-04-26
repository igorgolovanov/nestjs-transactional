import { Logger } from '@nestjs/common';

import { EventTypeRegistry } from '../serialization/event-type-registry';

import { ExternalizationRegistry } from './externalization-registry';
import { Externalized } from './externalized.decorator';

@Externalized<{ tenantId: string }>({
  target: 'orders',
  routingKey: (e) => e.tenantId,
  headers: (e) => ({ 'x-tenant': e.tenantId }),
  client: 'KAFKA_CLIENT',
})
class OrderPlacedEvent {
  constructor(readonly orderId: string, readonly tenantId: string) {}
}

@Externalized({
  target: 'audit.events',
  headers: { 'x-source': 'audit-svc' },
})
class AuditedEvent {
  constructor(readonly id: string) {}
}

class PlainEvent {
  constructor(readonly id: string) {}
}

describe('ExternalizationRegistry', () => {
  let eventTypes: EventTypeRegistry;
  let registry: ExternalizationRegistry;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    eventTypes = new EventTypeRegistry();
    eventTypes.registerAll([OrderPlacedEvent, AuditedEvent, PlainEvent]);
    registry = new ExternalizationRegistry(eventTypes);
    registry.onModuleInit();
  });

  it('indexes only event classes carrying @Externalized metadata', () => {
    expect(registry.has('OrderPlacedEvent')).toBe(true);
    expect(registry.has('AuditedEvent')).toBe(true);
    expect(registry.has('PlainEvent')).toBe(false);
  });

  it('returns the stored ExternalizedMetadata for a known type', () => {
    const metadata = registry.get('OrderPlacedEvent');

    expect(metadata).toBeDefined();
    expect(metadata?.target).toBe('orders');
    expect(metadata?.client).toBe('KAFKA_CLIENT');
    expect(typeof metadata?.routingKey).toBe('function');
    expect(typeof metadata?.headers).toBe('function');
  });

  it('returns undefined for an unknown type', () => {
    expect(registry.get('UnknownEvent')).toBeUndefined();
  });

  it('buildMetadata resolves a routingKey callback against the actual event instance', () => {
    const event = new OrderPlacedEvent('order-1', 'tenant-A');

    const built = registry.buildMetadata('OrderPlacedEvent', event);

    expect(built).toBeDefined();
    expect(built?.eventType).toBe('OrderPlacedEvent');
    expect(built?.target).toBe('orders');
    expect(built?.routingKey).toBe('tenant-A');
    expect(built?.client).toBe('KAFKA_CLIENT');
  });

  it('buildMetadata resolves a headers callback against the actual event instance', () => {
    const event = new OrderPlacedEvent('order-1', 'tenant-B');

    const built = registry.buildMetadata('OrderPlacedEvent', event);

    expect(built?.headers).toEqual({ 'x-tenant': 'tenant-B' });
  });

  it('buildMetadata passes through static headers without resolving', () => {
    const event = new AuditedEvent('audit-1');

    const built = registry.buildMetadata('AuditedEvent', event);

    expect(built?.headers).toEqual({ 'x-source': 'audit-svc' });
    expect(built?.routingKey).toBeUndefined();
  });

  it('buildMetadata returns undefined for non-externalized event types', () => {
    const event = new PlainEvent('plain-1');

    const built = registry.buildMetadata('PlainEvent', event);

    expect(built).toBeUndefined();
  });

  it('is empty when no @Externalized event classes are registered', () => {
    const emptyTypes = new EventTypeRegistry();
    emptyTypes.register(PlainEvent);
    const emptyRegistry = new ExternalizationRegistry(emptyTypes);
    emptyRegistry.onModuleInit();

    expect(emptyRegistry.get('PlainEvent')).toBeUndefined();
    expect(emptyRegistry.has('PlainEvent')).toBe(false);
  });
});
