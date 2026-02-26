import {
  EXTERNALIZED_METADATA,
  Externalized,
  getExternalizedMetadata,
} from './externalized.decorator';

describe('@Externalized', () => {
  it('attaches metadata to the decorated class', () => {
    @Externalized({ target: 'orders.placed' })
    class OrderPlacedEvent {}

    const metadata = getExternalizedMetadata(OrderPlacedEvent);

    expect(metadata).toBeDefined();
    expect(metadata?.target).toBe('orders.placed');
  });

  it('writes metadata under the public symbol so external tooling can read it', () => {
    @Externalized({ target: 'orders.placed' })
    class OrderPlacedEvent {}

    const metadata = Reflect.getMetadata(EXTERNALIZED_METADATA, OrderPlacedEvent) as unknown;

    expect(metadata).toBeDefined();
  });

  it('throws synchronously when target is missing (decorator-application time)', () => {
    expect(() =>
      Externalized({} as unknown as { target: string }),
    ).toThrow(/non-empty string/);
  });

  it('throws when target is an empty string', () => {
    expect(() => Externalized({ target: '' })).toThrow(/non-empty string/);
  });

  it('throws when target is a non-string (e.g. number, undefined)', () => {
    expect(() =>
      Externalized({ target: undefined as unknown as string }),
    ).toThrow(/non-empty string/);
    expect(() =>
      Externalized({ target: 42 as unknown as string }),
    ).toThrow(/non-empty string/);
  });

  it('returns undefined for classes that were not decorated', () => {
    class PlainEvent {}

    expect(getExternalizedMetadata(PlainEvent)).toBeUndefined();
  });

  it('preserves a routingKey callback verbatim — no resolution at decoration time', () => {
    const routingKey = jest.fn().mockReturnValue('tenant-A');

    @Externalized<{ tenantId: string }>({
      target: 'orders',
      routingKey: (e) => routingKey(e.tenantId),
    })
    class OrderPlacedEvent {
      constructor(readonly tenantId: string) {}
    }

    expect(routingKey).not.toHaveBeenCalled();
    const metadata = getExternalizedMetadata(OrderPlacedEvent);
    expect(typeof metadata?.routingKey).toBe('function');
  });

  it('preserves static headers as a record (not a function)', () => {
    @Externalized({
      target: 'orders',
      headers: { 'x-version': '1.0', 'x-source': 'orders-svc' },
    })
    class OrderPlacedEvent {}

    const metadata = getExternalizedMetadata(OrderPlacedEvent);
    expect(metadata?.headers).toEqual({
      'x-version': '1.0',
      'x-source': 'orders-svc',
    });
    expect(typeof metadata?.headers).toBe('object');
  });

  it('preserves a headers callback verbatim — does not invoke it at decoration time', () => {
    const headers = jest.fn().mockReturnValue({ 'x-tenant': 'A' });

    @Externalized<{ tenantId: string }>({
      target: 'orders',
      headers: (e) => headers(e.tenantId),
    })
    class OrderPlacedEvent {
      constructor(readonly tenantId: string) {}
    }

    expect(headers).not.toHaveBeenCalled();
    const metadata = getExternalizedMetadata(OrderPlacedEvent);
    expect(typeof metadata?.headers).toBe('function');
  });

  it('captures the optional client identifier when given', () => {
    const TOKEN = Symbol('KAFKA');

    @Externalized({ target: 'orders', client: TOKEN })
    class WithSymbol {}

    @Externalized({ target: 'orders', client: 'KAFKA_STR' })
    class WithString {}

    expect(getExternalizedMetadata(WithSymbol)?.client).toBe(TOKEN);
    expect(getExternalizedMetadata(WithString)?.client).toBe('KAFKA_STR');
  });
});
