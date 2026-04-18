import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';

import { AccountService } from './account.service';
import { AuditLoggingModule, readConfigFromEnv } from './app.module';
import { AccountRow, AuditLogRow } from './entities';

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AuditLoggingModule.forConfig(readConfigFromEnv()),
    { logger: ['error', 'warn', 'log'] },
  );

  const businessDs = app.get<DataSource>(getDataSourceToken());
  const auditDs = app.get<DataSource>(getDataSourceToken('audit'));
  const accounts = app.get(AccountService);

  await businessDs.manager.upsert(AccountRow, [{ id: 'acc-1', balance: 100 }], ['id']);

  console.log('=== audit-logging ===');

  console.log('1) deposit 50 → balance 150 → audit row appears in audit DB');
  await accounts.deposit('acc-1', 'op-1', 50);
  await waitFor(async () => (await auditDs.manager.countBy(AuditLogRow, { operationId: 'op-1' })) === 1);
  console.log('   business balance:', (await businessDs.manager.findOneBy(AccountRow, { id: 'acc-1' }))?.balance);
  console.log('   audit row:', await auditDs.manager.findOneBy(AuditLogRow, { operationId: 'op-1' }));

  console.log('2) withdraw 30 → balance 120 → second audit row');
  await accounts.withdraw('acc-1', 'op-2', 30);
  await waitFor(async () => (await auditDs.manager.countBy(AuditLogRow, { operationId: 'op-2' })) === 1);
  console.log('   business balance:', (await businessDs.manager.findOneBy(AccountRow, { id: 'acc-1' }))?.balance);
  console.log('   audit rows total:', await auditDs.manager.count(AuditLogRow));

  console.log('3) overdraw → throws → no audit row, balance unchanged (DD-019 + DD-023)');
  try {
    await accounts.withdraw('acc-1', 'op-3', 99_999);
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  // Worker waits a moment to confirm nothing landed.
  await new Promise((r) => setTimeout(r, 300));
  console.log('   business balance (still):', (await businessDs.manager.findOneBy(AccountRow, { id: 'acc-1' }))?.balance);
  console.log('   audit row for op-3:', await auditDs.manager.findOneBy(AuditLogRow, { operationId: 'op-3' }));
  console.log('   expected: null — the publish + balance update + operation row all rolled back together');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
