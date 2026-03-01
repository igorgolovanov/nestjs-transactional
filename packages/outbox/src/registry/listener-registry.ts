import { Injectable } from '@nestjs/common';

import { DuplicateListenerIdError } from '../types/errors';

/**
 * A listener registered with the {@link OutboxListenerRegistry}.
 *
 * `id` is stable across restarts — it is persisted on every
 * {@link EventPublication} row, so renaming the method breaks resume /
 * retry of stored publications. Consumers are expected to either use
 * the default `"ClassName.methodName"` shape or supply an explicit id
 * in the decorator's options (see ADR-009 — planned).
 */
export interface RegisteredOutboxListener {
  /** Globally-unique listener id (e.g. `"InventoryModule.onOrderPlaced"`). */
  readonly id: string;
  /** Event class name this listener subscribes to. */
  readonly eventType: string;
  /** Invoke the listener with a decoded event payload. */
  readonly invoke: (event: unknown) => Promise<void>;
}

/**
 * Registry of `@OutboxEventsHandler`-annotated classes (and other
 * programmatically-registered listeners such as those routed from
 * `@IntegrationEventsHandler` via the structural registrar port),
 * keyed by both the listener id (for targeted dispatch / resume) and
 * the event class name (for fan-out when a new event is published).
 *
 * Populated at application bootstrap by the scanner (upcoming Phase 5
 * iteration). Stateless beyond the two index maps.
 */
@Injectable()
export class OutboxListenerRegistry {
  private readonly listenersByEventType = new Map<string, RegisteredOutboxListener[]>();
  private readonly listenersById = new Map<string, RegisteredOutboxListener>();

  /**
   * Index a listener under both its id and its event type.
   *
   * @throws {DuplicateListenerIdError} when a listener with the same
   * id is already registered — ids must be unique to avoid
   * non-deterministic dispatch.
   */
  register(listener: RegisteredOutboxListener): void {
    if (this.listenersById.has(listener.id)) {
      throw new DuplicateListenerIdError(listener.id);
    }

    const listeners = this.listenersByEventType.get(listener.eventType) ?? [];
    listeners.push(listener);
    this.listenersByEventType.set(listener.eventType, listeners);
    this.listenersById.set(listener.id, listener);
  }

  /**
   * Return every listener subscribed to the given event class name, in
   * registration order. Returns `[]` (never `undefined`) for unknown
   * event types.
   */
  getByEventType(eventType: string): RegisteredOutboxListener[] {
    return this.listenersByEventType.get(eventType) ?? [];
  }

  /** Return the listener with the given id, or `undefined` when not registered. */
  getById(id: string): RegisteredOutboxListener | undefined {
    return this.listenersById.get(id);
  }

  /** Return every registered listener, in registration order. */
  getAll(): RegisteredOutboxListener[] {
    return Array.from(this.listenersById.values());
  }

  /** Drop every registered listener. Primarily a testing convenience. */
  clear(): void {
    this.listenersByEventType.clear();
    this.listenersById.clear();
  }
}
