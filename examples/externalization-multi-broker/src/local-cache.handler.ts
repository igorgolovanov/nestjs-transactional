import { Injectable, Logger } from '@nestjs/common';
import { type IOutboxEventHandler, OutboxEventsHandler } from '@nestjs-transactional/outbox';

import { CacheInvalidationEvent } from './cache-invalidation.event';

/**
 * Local listener for `CacheInvalidationEvent`. Drops the affected key
 * from the in-process cache before the externalizer fans the event
 * out to other instances over Redis pub/sub.
 *
 * Local-first ordering matters here: the publishing instance MUST
 * drop its own cached value first. Otherwise a concurrent read could
 * repopulate the cache from this instance with the about-to-be-stale
 * value AFTER Redis fanout completes.
 */
@Injectable()
@OutboxEventsHandler({ events: [CacheInvalidationEvent], id: 'LocalCache.drop' })
export class LocalCacheInvalidator implements IOutboxEventHandler<CacheInvalidationEvent> {
  private readonly logger = new Logger(LocalCacheInvalidator.name);

  readonly handled: CacheInvalidationEvent[] = [];

  async handle(event: CacheInvalidationEvent): Promise<void> {
    this.logger.log(`Local: dropping cache key '${event.key}' (${event.reason})`);
    this.handled.push(event);
  }
}
