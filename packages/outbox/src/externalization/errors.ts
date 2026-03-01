import { OutboxError } from '../types/errors';

/**
 * Raised when an {@link EventExternalizer} fails to deliver a
 * publication to its external broker target. Carries diagnostic
 * context (event type, broker target, optional underlying cause) so
 * operators can correlate a `FAILED` publication row with the broker
 * issue without parsing free-form messages.
 *
 * Implementations are encouraged to wrap transport-specific failures
 * in this error, but the `EventPublicationProcessor` does not
 * require it — any rejection from `externalize()` is recorded on the
 * publication.
 */
export class ExternalizationError extends OutboxError {
  readonly code = 'EXTERNALIZATION_ERROR';

  constructor(
    message: string,
    readonly eventType: string,
    readonly target: string,
    readonly cause?: Error,
  ) {
    super(message);
  }
}
