import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AuditArchivalHandler } from './audit/audit-archival.handler';
import { AuditService } from './audit/audit.service';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Resolves the env file from `NODE_ENV` and boots the stack. Set
 * `NODE_ENV=staging` (or `production`) before running to switch
 * profiles without touching code.
 */
async function main(): Promise<void> {
  const env = process.env.NODE_ENV ?? 'development';
  const envFilePath = `.env.${env}`;

  const app = await NestFactory.createApplicationContext(
    AppModule.forEnv({ envFilePath }),
    { logger: ['error', 'warn', 'log'] },
  );

  const cfg = app.get(ConfigService);
  const audit = app.get(AuditService);
  const archival = app.get(AuditArchivalHandler);

  console.log(`=== async-config-from-environment (NODE_ENV=${env}) ===`);
  console.log(`db    : ${cfg.get('PG_HOST')}:${cfg.get('PG_PORT')}/${cfg.get('PG_DATABASE')}`);
  console.log(
    `outbox: poll=${cfg.get('OUTBOX_POLLING_INTERVAL_MS')}ms ` +
      `batch=${cfg.get('OUTBOX_BATCH_SIZE')} ` +
      `concurrency=${cfg.get('OUTBOX_MAX_CONCURRENT')}`,
  );

  await audit.recordEvent('a-1', 'UserSignedIn', { userId: 'u-42' });
  console.log(`audit rows : ${(await audit.findAll()).map((e) => e.id).join(', ')}`);

  await waitFor(() => archival.archived.some((e) => e.entryId === 'a-1'));
  console.log(`archived   : ${archival.archived.map((e) => e.entryId).join(', ')}`);

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
