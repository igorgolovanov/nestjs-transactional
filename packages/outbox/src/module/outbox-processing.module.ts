import {
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';

import {
  OUTBOX_PROCESSING_BUNDLE,
  type OutboxProcessingBundle,
} from './outbox.module';

/**
 * Auto-starts every configured per-dataSource
 * {@link EventPublicationProcessor} and {@link StalenessMonitor} on
 * application bootstrap and stops them on shutdown.
 *
 * Phase 14.3 generalised this to multi-dataSource: the module reads
 * {@link OUTBOX_PROCESSING_BUNDLE} provided by `OutboxModule.forRoot`
 * — the bundle contains arrays of per-dataSource processors and
 * monitors. Single-dataSource deployments see the bundle with
 * exactly one processor and one monitor; nothing changes for them.
 *
 * Import this module in applications that SHOULD drain every
 * configured outbox (typically a dedicated worker process), but NOT
 * in API applications that only publish events — they should leave
 * processing to the worker.
 *
 * Assumes {@link OutboxModule} is already registered earlier in the
 * module tree (usually as `OutboxModule.forRoot({ isGlobal: true })`);
 * the bundle is looked up from the global DI scope.
 */
@Module({})
export class OutboxProcessingModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(OUTBOX_PROCESSING_BUNDLE)
    private readonly bundle: OutboxProcessingBundle,
  ) {}

  onApplicationBootstrap(): void {
    for (const processor of this.bundle.processors) {
      processor.start();
    }
    for (const monitor of this.bundle.monitors) {
      monitor.start();
    }
  }

  /**
   * Drain every worker before NestJS proceeds with the rest of the
   * teardown.
   *
   * Awaited on purpose: the hook used to be synchronous, so NestJS moved
   * straight on to destroying providers — the DataSource among them —
   * while a batch dispatched by the previous tick was still running.
   * That could interrupt a publication's `PROCESSING → COMPLETED`
   * transition and strand the row until the staleness monitor found it.
   *
   * Each worker's drain is individually bounded (`shutdownTimeout`), so
   * a stuck listener delays shutdown by at most that budget. Drains run
   * concurrently rather than in sequence: they are independent, and
   * serialising them would add up the budgets in multi-dataSource
   * deployments.
   */
  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      ...this.bundle.processors.map((processor) => processor.stop()),
      ...this.bundle.monitors.map((monitor) => monitor.stop()),
    ]);
  }
}
