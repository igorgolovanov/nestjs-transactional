import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule, readPostgresConfigFromEnv } from './app.module';
import { AuditService } from './audit/audit.service';

/**
 * Visual demo. Records an audit event every two seconds in a loop.
 * The slow archival handler picks each one up, takes ~400ms to
 * process, and the publication completes.
 *
 * `app.enableShutdownHooks()` is the line that turns Node signal
 * handlers (SIGTERM, SIGINT) into NestJS lifecycle hooks. Without
 * it, hitting `Ctrl+C` would kill the process IMMEDIATELY without
 * running `OnApplicationShutdown`, leaving the worker mid-batch
 * and the database connection unclosed.
 *
 * Try it:
 *   pnpm start
 *   # in another terminal:
 *   kill -TERM $(pgrep -f graceful-shutdown/dist/main.js)
 *
 * Watch the logs flow through:
 *   • EventPublicationProcessor stopped
 *   • Draining outbox (signal=SIGTERM)…
 *   • Outbox drained cleanly in 412ms
 *   • ExampleCleanupService done (signal=SIGTERM)
 *   • [TypeOrmModule] Database connection closed
 */
async function main(): Promise<void> {
  const config = readPostgresConfigFromEnv();
  const app = await NestFactory.createApplicationContext(AppModule.forPostgres(config), {
    logger: ['error', 'warn', 'log'],
  });

  app.enableShutdownHooks();

  const audit = app.get(AuditService);

  console.log('=== graceful-shutdown ===');
  console.log('Recording one audit event every 2s. Send SIGTERM (Ctrl+C) to drain.');

  let counter = 0;
  const interval = setInterval(() => {
    void audit
      .recordEvent(`a-${++counter}`, `tick #${counter}`)
      .catch((err: unknown) => console.error('recordEvent failed:', err));
  }, 2_000);

  // Clear the demo timer on shutdown. NestJS owns the lifecycle
  // chain via `enableShutdownHooks` above, but the timer is not a
  // Nest provider — it lives in this script's closure, so wire its
  // cleanup directly to the same signals.
  process.once('SIGTERM', () => clearInterval(interval));
  process.once('SIGINT', () => clearInterval(interval));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
