import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { IncompleteEventPublications } from '../api/incomplete-event-publications';
import { ResubmissionOptions } from '../types/resubmission-options';

/** DI token for {@link OutboxRecoveryOptions}. */
export const OUTBOX_RECOVERY_OPTIONS = Symbol('OUTBOX_RECOVERY_OPTIONS');

/**
 * Runtime configuration for {@link StartupRecoveryService}. Wired by
 * `OutboxModule.forRoot` from the module-level options.
 */
export interface OutboxRecoveryOptions {
  /**
   * When `true`, every non-`COMPLETED` publication found at
   * application bootstrap is transitioned to `RESUBMITTED` so the
   * processor picks it up after the previous-run crash.
   */
  readonly republishOnStartup: boolean;
  /**
   * Maximum number of publications to resubmit in a single bootstrap
   * pass. Defaults to 1000 when omitted.
   */
  readonly startupBatchSize?: number;
}

/**
 * `OnApplicationBootstrap` hook that optionally resubmits every
 * publication left in a non-terminal state when the previous process
 * died — matches Spring Modulith's `Republishing on Startup`
 * behaviour.
 *
 * Skips entirely when `republishOnStartup` is `false` (the default).
 */
@Injectable()
export class StartupRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupRecoveryService.name);

  constructor(
    private readonly incomplete: IncompleteEventPublications,
    @Inject(OUTBOX_RECOVERY_OPTIONS)
    private readonly options: OutboxRecoveryOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.republishOnStartup) {
      return;
    }

    this.logger.log('Checking for incomplete publications to republish...');

    const count = await this.incomplete.resubmitIncompletePublications(
      ResubmissionOptions.defaults().withBatchSize(this.options.startupBatchSize ?? 1000),
    );

    if (count > 0) {
      this.logger.log(`Resubmitted ${count} incomplete publication(s) from previous run`);
    }
  }
}
