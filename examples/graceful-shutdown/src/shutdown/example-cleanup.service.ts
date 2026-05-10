import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';

/**
 * Stand-in for "any user-defined cleanup that should run on
 * shutdown" — flushing an in-process metrics buffer, closing a
 * Redis connection that isn't owned by Nest, telling a sidecar
 * proxy to stop accepting traffic, etc.
 *
 * Both NestJS hooks compose: the framework's
 * `OutboxProcessingModule.onApplicationShutdown` (stops polling),
 * `OutboxDrainService.onApplicationShutdown` (awaits in-flight),
 * and *this* one all run during `app.close()` — the order is
 * NestJS's reverse-init order, but their effects are independent
 * so order doesn't matter here.
 *
 * The integration test asserts this hook fires (via the public
 * `cleaned` flag) so users see the wiring works without having to
 * dig into Nest internals.
 */
@Injectable()
export class ExampleCleanupService implements OnApplicationShutdown {
  private readonly logger = new Logger(ExampleCleanupService.name);

  cleaned = false;
  signalReceived: string | undefined;

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.signalReceived = signal;
    // A real cleanup might be async — flushing a buffer, awaiting an
    // RPC, etc. The hook is allowed to return a Promise, and NestJS
    // awaits it before tearing down the rest of the app.
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.cleaned = true;
    this.logger.log(`ExampleCleanupService done (signal=${signal ?? 'none'})`);
  }
}
