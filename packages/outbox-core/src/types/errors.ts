import { TransactionError } from '@nestjs-transactional/core';

import type { PublicationStatus } from './publication-status';

/**
 * Base class for errors raised by `@nestjs-transactional/outbox-core`.
 * Subclass for any specific failure mode so that callers can match on
 * `code` without relying on string parsing.
 */
export class OutboxError extends TransactionError {
  readonly code: string = 'OUTBOX_ERROR';
}

/**
 * Raised when a lookup by publication ID finds no matching record.
 */
export class PublicationNotFoundError extends OutboxError {
  readonly code = 'PUBLICATION_NOT_FOUND';

  constructor(id: string) {
    super(`Publication not found: ${id}`);
  }
}

/**
 * Raised when the registry is asked to move a publication to a state
 * that is not reachable from its current one — e.g. `COMPLETED` →
 * `PROCESSING`.
 */
export class InvalidPublicationTransitionError extends OutboxError {
  readonly code = 'INVALID_PUBLICATION_TRANSITION';

  constructor(from: PublicationStatus, to: PublicationStatus) {
    super(`Invalid publication state transition: ${from} → ${to}`);
  }
}

/**
 * Raised when the serializer cannot encode an event payload — typically
 * because the payload contains non-plain values (functions, cycles, ...).
 */
export class SerializationError extends OutboxError {
  readonly code = 'SERIALIZATION_ERROR';
}

/**
 * Raised when the serializer cannot decode a stored event payload —
 * typically because the schema has drifted or the type is unregistered.
 */
export class DeserializationError extends OutboxError {
  readonly code = 'DESERIALIZATION_ERROR';
}
