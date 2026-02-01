/**
 * Serializes events for storage in the publication log and deserializes
 * them back into application objects when a publication is picked up by
 * a worker.
 *
 * Inspired by Spring Modulith's `EventSerializer`.
 *
 * Implementations are expected to:
 * - throw `SerializationError` when encoding fails (circular refs,
 *   unsupported values);
 * - throw `DeserializationError` when decoding fails (malformed payload,
 *   schema drift, missing type);
 * - be deterministic so the same input yields the same output.
 */
export interface EventSerializer {
  /** Encode an event payload into a string suitable for row storage. */
  serialize(event: unknown): string;
  /**
   * Decode a previously-serialized payload back into an application
   * object. `eventType` is the class name recorded alongside the
   * payload — the implementation may use it to look up a class
   * prototype via an {@link EventTypeRegistry} or similar.
   */
  deserialize(serialized: string, eventType: string): unknown;
}

/** DI token for the active {@link EventSerializer} implementation. */
export const EVENT_SERIALIZER = Symbol('EVENT_SERIALIZER');
