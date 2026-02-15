import { Injectable, type Type } from '@nestjs/common';

import { PublishedEvents, type PublishedEventsView } from './published-events';

/**
 * Thrown when an assertion made against the published-events view does
 * not hold. A separate class (instead of a plain `Error`) so tests can
 * pattern-match with `rejects.toBeInstanceOf(PublishedEventsAssertionError)`
 * when they want to assert on failure modes.
 */
export class PublishedEventsAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishedEventsAssertionError';
  }
}

/**
 * Jest-friendly fluent assertions over {@link PublishedEvents}. Inspired
 * by Spring Modulith's `AssertablePublishedEvents`. Designed to read
 * naturally at the call site:
 *
 * ```ts
 * const view = await assertablePublishedEvents.contains(OrderPlacedEvent);
 * view.matching((e) => e.orderId, 'order-123').hasSize(1);
 * ```
 *
 * Both assertions throw {@link PublishedEventsAssertionError} on
 * failure, which Jest renders as a normal test failure.
 */
@Injectable()
export class AssertablePublishedEvents {
  constructor(private readonly events: PublishedEvents) {}

  /**
   * Assert that at least one event of the given class was published,
   * then return a view over those events for further assertions.
   *
   * @throws {PublishedEventsAssertionError} when no matching event
   *   was published.
   */
  async contains<T extends object>(eventType: Type<T>): Promise<AssertionView<T>> {
    const view = this.events.ofType(eventType);
    const events = await view.get();
    if (events.length === 0) {
      throw new PublishedEventsAssertionError(
        `Expected at least one event of type ${eventType.name}, but found none`,
      );
    }
    return new AssertionView<T>(view, events, eventType);
  }

  /**
   * Assert that NO event of the given class was published.
   *
   * @throws {PublishedEventsAssertionError} when one or more matching
   *   events were published.
   */
  async doesNotContain<T extends object>(eventType: Type<T>): Promise<void> {
    const events = await this.events.ofType(eventType).get();
    if (events.length > 0) {
      throw new PublishedEventsAssertionError(
        `Expected no events of type ${eventType.name}, but found ${events.length}`,
      );
    }
  }
}

/**
 * Materialised, filtered view returned by
 * {@link AssertablePublishedEvents.contains}. Further filtering /
 * sizing runs in memory — no additional repository reads.
 */
export class AssertionView<T extends object> {
  constructor(
    private readonly view: PublishedEventsView<T>,
    private readonly events: readonly T[],
    private readonly eventType: Type<T>,
  ) {}

  /**
   * Narrow the view to events whose derived value equals `expected`.
   * Returns a new {@link AssertionView} so assertions can chain.
   *
   * @throws {PublishedEventsAssertionError} when no event in the
   *   current view matches.
   */
  matching<K>(getter: (event: T) => K, expected: K): AssertionView<T> {
    const filtered = this.events.filter((event) => getter(event) === expected);
    if (filtered.length === 0) {
      throw new PublishedEventsAssertionError(
        `Expected at least one event of type ${this.eventType.name} matching the predicate, but none found`,
      );
    }
    return new AssertionView<T>(this.view, filtered, this.eventType);
  }

  /**
   * Assert the view contains exactly `expected` events.
   *
   * @throws {PublishedEventsAssertionError} when the count differs.
   */
  hasSize(expected: number): this {
    if (this.events.length !== expected) {
      throw new PublishedEventsAssertionError(
        `Expected ${expected} events of type ${this.eventType.name}, but found ${this.events.length}`,
      );
    }
    return this;
  }

  /** Read the current events. Useful for ad-hoc assertions with Jest's matchers. */
  toArray(): T[] {
    return [...this.events];
  }
}
