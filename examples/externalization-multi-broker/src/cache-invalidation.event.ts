import { Externalized } from '@nestjs-transactional/outbox';

import { REDIS_CLIENT } from './clients';

/**
 * Domain event routed to **Redis pub/sub** — ephemeral, fan-out, no
 * durability guarantees beyond the moment of publication. Suits cache
 * invalidation: every running instance of a downstream service
 * subscribes to the channel and drops the affected key from its local
 * cache, with no ack and no replay needed.
 *
 * `target` is the Redis pub/sub channel name. Consumers subscribe via
 * `Transport.REDIS` with a matching pattern.
 */
@Externalized<CacheInvalidationEvent>({
  target: 'cache.invalidated',
  client: REDIS_CLIENT,
})
export class CacheInvalidationEvent {
  constructor(
    public readonly key: string,
    public readonly reason: string,
  ) {}
}
