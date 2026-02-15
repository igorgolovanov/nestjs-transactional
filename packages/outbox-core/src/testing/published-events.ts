import { Inject, Injectable, type Type } from '@nestjs/common';

import {
  EVENT_PUBLICATION_REPOSITORY,
  type EventPublicationRepository,
} from '../repository/event-publication-repository';
import { EVENT_SERIALIZER, type EventSerializer } from '../serialization/event-serializer';
import type { EventPublication } from '../types/event-publication';

/**
 * Test utility for inspecting events that were published through the
 * outbox during a test run.
 *
 * Inspired by Spring Modulith's `PublishedEvents`. Reads from whichever
 * `EventPublicationRepository` implementation is wired — typically
 * {@link InMemoryEventPublicationRepository} for unit-level tests, or
 * the TypeORM-backed repository for integration tests against a real
 * database. The events are deserialized back into application objects
 * via the configured {@link EventSerializer} so tests can assert on
 * the same typed payloads the listeners would receive.
 */
@Injectable()
export class PublishedEvents {
  constructor(
    @Inject(EVENT_PUBLICATION_REPOSITORY)
    private readonly repository: EventPublicationRepository,
    @Inject(EVENT_SERIALIZER)
    private readonly serializer: EventSerializer,
  ) {}

  /**
   * Every publication visible to the repository, regardless of status.
   * Events are returned as deserialized application objects. Ordering
   * mirrors the repository's own — typically insertion order for the
   * in-memory impl, unspecified for SQL-backed ones.
   */
  async all(): Promise<unknown[]> {
    const rows = await this.collectAll();
    return rows.map((pub) =>
      this.serializer.deserialize(pub.serializedEvent, pub.eventType),
    );
  }

  /**
   * Narrow the view to events of a specific class. Subsequent
   * `matching(...)` / `count()` / `get()` calls filter only within
   * that class.
   */
  ofType<T extends object>(eventType: Type<T>): PublishedEventsView<T> {
    return new PublishedEventsView<T>(
      () => this.collectAll(),
      this.serializer,
      eventType,
      [],
    );
  }

  private async collectAll(): Promise<EventPublication[]> {
    const [incomplete, completed] = await Promise.all([
      this.repository.findIncomplete(),
      this.repository.findCompleted(),
    ]);
    return [...incomplete, ...completed];
  }
}

/**
 * Fluent filter view returned by {@link PublishedEvents.ofType}. Each
 * `matching(...)` call produces a new view with the extra predicate
 * appended — predicates are conjunctive (all must hold). Materialise
 * the view with `get()` or `count()`.
 */
export class PublishedEventsView<T extends object> {
  constructor(
    private readonly fetchAll: () => Promise<EventPublication[]>,
    private readonly serializer: EventSerializer,
    private readonly eventType: Type<T>,
    private readonly predicates: readonly ((event: T) => boolean)[],
  ) {}

  /**
   * Filter on a boolean predicate over the deserialized event.
   */
  matching(predicate: (event: T) => boolean): PublishedEventsView<T>;
  /**
   * Filter on equality of a derived value. Equivalent to
   * `matching((e) => getter(e) === expected)` but cheaper to read.
   */
  matching<K>(getter: (event: T) => K, expected: K): PublishedEventsView<T>;
  matching<K>(
    fnOrGetter: ((event: T) => boolean) | ((event: T) => K),
    expected?: K,
  ): PublishedEventsView<T> {
    // eslint-disable-next-line prefer-rest-params -- arguments.length distinguishes the two overloads reliably, including when `expected` is intentionally `undefined`.
    const argCount = arguments.length;
    const predicate: (event: T) => boolean =
      argCount > 1
        ? (event: T): boolean => (fnOrGetter as (event: T) => K)(event) === (expected as K)
        : (fnOrGetter as (event: T) => boolean);

    return new PublishedEventsView<T>(
      this.fetchAll,
      this.serializer,
      this.eventType,
      [...this.predicates, predicate],
    );
  }

  /** Number of matching events. Materialises the view. */
  async count(): Promise<number> {
    return (await this.get()).length;
  }

  /** Deserialized, filtered events. Materialises the view. */
  async get(): Promise<T[]> {
    const rows = await this.fetchAll();
    const typed: T[] = rows
      .filter((pub) => pub.eventType === this.eventType.name)
      .map((pub) => this.serializer.deserialize(pub.serializedEvent, pub.eventType) as T);
    return typed.filter((event) => this.predicates.every((pred) => pred(event)));
  }
}
