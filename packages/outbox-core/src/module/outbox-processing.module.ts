import {
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import { StalenessMonitor } from '../recovery/staleness-monitor';

/**
 * Auto-starts {@link EventPublicationProcessor} and
 * {@link StalenessMonitor} on application bootstrap and stops them on
 * shutdown.
 *
 * Import this module in applications that SHOULD drain the outbox
 * (typically a dedicated worker process), but NOT in API applications
 * that only publish events — they should leave processing to the
 * worker.
 *
 * Assumes {@link OutboxModule} is already registered earlier in the
 * module tree (usually as `OutboxModule.forRoot({ isGlobal: true })`);
 * the processor / monitor providers are looked up from the global DI
 * scope, no explicit import is required here.
 */
@Module({})
export class OutboxProcessingModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    private readonly processor: EventPublicationProcessor,
    private readonly stalenessMonitor: StalenessMonitor,
  ) {}

  onApplicationBootstrap(): void {
    this.processor.start();
    this.stalenessMonitor.start();
  }

  onApplicationShutdown(): void {
    this.processor.stop();
    this.stalenessMonitor.stop();
  }
}
