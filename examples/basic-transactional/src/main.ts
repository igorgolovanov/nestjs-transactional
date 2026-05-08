import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { UserService } from './user.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const users = app.get(UserService);

  console.log('=== basic-transactional ===');

  console.log('1) createUser("alice") inside @Transactional');
  await users.createUser('alice', 'Alice');
  console.log('   after commit, DB rows:', (await users.listAll()).map((u) => u.id));

  console.log('2) createUserAndFail("bob") — service throws inside @Transactional');
  try {
    await users.createUserAndFail('bob', 'Bob');
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  console.log('   after rollback, DB rows:', (await users.listAll()).map((u) => u.id));

  console.log('   expected: bob is NOT in the list — write rolled back');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
