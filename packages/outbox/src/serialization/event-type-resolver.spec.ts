import { OutboxError } from '../types/errors';

import { EventTypeRegistry } from './event-type-registry';
import { resolveDataSourceByEventTypeName } from './event-type-resolver';

class FooEvent {}
class BarEvent {}

describe('resolveDataSourceByEventTypeName', () => {
  let defaultEtr: EventTypeRegistry;
  let billingEtr: EventTypeRegistry;
  let inventoryEtr: EventTypeRegistry;
  let registries: Map<string, EventTypeRegistry>;

  beforeEach(() => {
    defaultEtr = new EventTypeRegistry();
    billingEtr = new EventTypeRegistry();
    inventoryEtr = new EventTypeRegistry();
    registries = new Map<string, EventTypeRegistry>([
      ['default', defaultEtr],
      ['billing', billingEtr],
      ['inventory', inventoryEtr],
    ]);
  });

  it('returns the dataSource that owns the event when exactly one match exists', () => {
    billingEtr.register(FooEvent);

    expect(resolveDataSourceByEventTypeName('FooEvent', registries)).toBe('billing');
  });

  it("returns 'default' when only the default-DS registry owns the event", () => {
    defaultEtr.register(FooEvent);

    expect(resolveDataSourceByEventTypeName('FooEvent', registries)).toBe('default');
  });

  it('throws OutboxError naming the event when no registry owns it', () => {
    expect(() => resolveDataSourceByEventTypeName('UnregisteredEvent', registries)).toThrow(
      OutboxError,
    );
    try {
      resolveDataSourceByEventTypeName('UnregisteredEvent', registries);
    } catch (err) {
      expect((err as Error).message).toContain('UnregisteredEvent');
      expect((err as Error).message).toContain('OutboxModule.forFeature');
    }
  });

  it('throws OutboxError listing every owning dataSource when the event is ambiguous', () => {
    defaultEtr.register(FooEvent);
    billingEtr.register(FooEvent);

    expect(() => resolveDataSourceByEventTypeName('FooEvent', registries)).toThrow(
      OutboxError,
    );
    try {
      resolveDataSourceByEventTypeName('FooEvent', registries);
    } catch (err) {
      expect((err as Error).message).toContain('FooEvent');
      expect((err as Error).message).toContain('default');
      expect((err as Error).message).toContain('billing');
    }
  });

  it('treats an empty registries Map as "no match"', () => {
    expect(() => resolveDataSourceByEventTypeName('FooEvent', new Map())).toThrow(OutboxError);
  });

  it('keys lookup by event-type NAME, not by class identity', () => {
    // Two distinct classes with the same name in different files should
    // not normally coexist, but the helper is explicitly name-keyed —
    // it's the registry's contract too. Pin the contract.
    billingEtr.register(BarEvent);

    expect(resolveDataSourceByEventTypeName('BarEvent', registries)).toBe('billing');
  });
});
