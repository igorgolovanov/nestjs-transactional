import { Injectable } from '@nestjs/common';

import { DeserializationError, SerializationError } from '../types/errors';

import type { EventSerializer } from './event-serializer';
import { EventTypeRegistry } from './event-type-registry';

/**
 * Default JSON-based {@link EventSerializer}. Uses `JSON.stringify` for
 * encoding and `JSON.parse` + `Object.create` for decoding, consulting
 * an {@link EventTypeRegistry} to restore the class prototype when
 * possible.
 *
 * This implementation is intentionally simple: it restores the
 * prototype but does not call the constructor, so classes with private
 * fields, Value-Object invariants, or custom deserialization must
 * provide their own `EventSerializer`.
 */
@Injectable()
export class JsonEventSerializer implements EventSerializer {
  constructor(private readonly registry: EventTypeRegistry) {}

  serialize(event: unknown): string {
    if (!event || typeof event !== 'object') {
      throw new SerializationError(`Cannot serialize non-object: ${typeof event}`);
    }
    try {
      return JSON.stringify(event);
    } catch (err) {
      throw new SerializationError(
        `Failed to serialize event: ${(err as Error).message}`,
      );
    }
  }

  deserialize(serialized: string, eventType: string): unknown {
    const EventClass = this.registry.get(eventType);

    let data: unknown;
    try {
      data = JSON.parse(serialized);
    } catch (err) {
      throw new DeserializationError(
        `Failed to deserialize event '${eventType}': ${(err as Error).message}`,
      );
    }

    if (!EventClass) {
      return data;
    }

    const prototype: object = EventClass.prototype as object;
    return Object.assign(Object.create(prototype) as object, data);
  }
}
