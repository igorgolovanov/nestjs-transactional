import { Injectable, Type } from '@nestjs/common';

/**
 * Registry that maps event class names to their constructors so the
 * serializer can reconstruct class instances from stored JSON payloads.
 *
 * Event classes are registered at application startup, typically via
 * `OutboxModule.forFeature([...])` in the feature module that owns the
 * event class. Each event type can only be registered once — duplicate
 * registrations throw at bootstrap, so a misconfigured module fails
 * fast rather than silently shadowing an earlier registration.
 */
@Injectable()
export class EventTypeRegistry {
  private readonly registry = new Map<string, Type<object>>();

  /**
   * Register a single event class, keyed by its constructor name.
   *
   * @throws `Error` when an event class with the same constructor name
   * has already been registered. Duplicate registration almost always
   * indicates a configuration bug (the same event type appearing in
   * two `forFeature` calls) — fail fast rather than silently shadow.
   */
  register(eventType: Type<object>): void {
    if (this.registry.has(eventType.name)) {
      throw new Error(
        `Event type '${eventType.name}' already registered. ` +
          `Each event type can only be registered once — check for ` +
          `duplicate entries across OutboxModule.forFeature() calls.`,
      );
    }
    this.registry.set(eventType.name, eventType);
  }

  /** Register many event classes at once. */
  registerAll(eventTypes: Type<object>[]): void {
    for (const type of eventTypes) {
      this.register(type);
    }
  }

  /** Return the registered class for the given name, or `undefined`. */
  get(typeName: string): Type<object> | undefined {
    return this.registry.get(typeName);
  }

  /**
   * Return the registered class for the given name.
   *
   * @throws `Error` with an actionable message when the type is
   * unregistered — tells the caller how to register it.
   */
  getOrThrow(typeName: string): Type<object> {
    const type = this.registry.get(typeName);
    if (!type) {
      throw new Error(
        `Event type '${typeName}' not registered. ` +
          `Ensure it's registered via OutboxModule.forFeature([...]) in ` +
          `the feature module that owns this event class.`,
      );
    }
    return type;
  }

  /** Whether the given type name is known to the registry. */
  has(typeName: string): boolean {
    return this.registry.has(typeName);
  }

  /** Return a snapshot of all registered entries. Mutations are not observed. */
  getAll(): Map<string, Type<object>> {
    return new Map(this.registry);
  }
}

/** DI token for the {@link EventTypeRegistry}. */
export const EVENT_TYPE_REGISTRY = Symbol('EVENT_TYPE_REGISTRY');
