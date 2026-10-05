import {
  Externalized,
  ExternalizedRouteConflictError,
  externalizedRoutes,
  getExternalizedMetadata,
} from './externalized.decorator.js';

describe('@Externalized', () => {
  it('stores the metadata on the event class', () => {
    @Externalized<{ id: string }>({
      target: 'spec.metadata',
      client: 'KAFKA',
      routingKey: (e) => e.id,
      headers: { source: 'spec' },
    })
    class OrderPlaced {
      constructor(readonly id: string) {}
    }

    const meta = getExternalizedMetadata(OrderPlaced);
    expect(meta?.target).toBe('spec.metadata');
    expect(meta?.client).toBe('KAFKA');
    expect(meta?.routingKey?.(new OrderPlaced('o-1'))).toBe('o-1');
    expect(meta?.headers).toEqual({ source: 'spec' });
  });

  it('returns undefined for a class without the decorator', () => {
    class Plain {}
    expect(getExternalizedMetadata(Plain)).toBeUndefined();
  });

  it('rejects an empty target', () => {
    expect(() => Externalized({ target: '' })).toThrow(/target/);
  });

  it('records target -> client for routing', () => {
    @Externalized({ target: 'spec.route', client: 'RMQ' })
    class Routed {}
    void Routed;

    expect(externalizedRoutes().get('spec.route')).toEqual({ client: 'RMQ' });
  });

  it('accepts a second class on the same target and client', () => {
    @Externalized({ target: 'spec.shared', client: 'KAFKA' })
    class First {}
    @Externalized({ target: 'spec.shared', client: 'KAFKA' })
    class Second {}
    void First;
    void Second;

    expect(externalizedRoutes().get('spec.shared')).toEqual({ client: 'KAFKA' });
  });

  it('fails at decoration when one target is declared with two clients', () => {
    @Externalized({ target: 'spec.conflict', client: 'KAFKA' })
    class First {}
    void First;

    expect(() => {
      @Externalized({ target: 'spec.conflict', client: 'RMQ' })
      class Second {}
      void Second;
    }).toThrow(ExternalizedRouteConflictError);
  });
});
