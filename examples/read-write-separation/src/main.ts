import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule, readConfigFromEnv } from './app.module';
import { ArticleQueryService } from './article.query-service';
import { ArticleService } from './article.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    AppModule.forConfig(readConfigFromEnv()),
    { logger: ['error', 'warn', 'log'] },
  );

  const articles = app.get(ArticleService);
  const query = app.get(ArticleQueryService);

  console.log('=== read-write-separation ===');

  console.log('1) create("a-1") via master, then read via replica');
  await articles.create('a-1', 'first', 'hello');
  const a1 = await query.getById('a-1');
  console.log('   replica saw:', a1);

  console.log('2) update("a-1") via master, replica reflects new body');
  await articles.update('a-1', 'updated body');
  const a1Updated = await query.getById('a-1');
  console.log('   replica saw body:', a1Updated?.body);

  console.log('3) createAndFail("a-2") rolls back; replica shows count unchanged');
  const beforeCount = await query.count();
  try {
    await articles.createAndFail('a-2', 'lost', 'this never persists');
  } catch (err) {
    console.log('   caught:', (err as Error).message);
  }
  const afterCount = await query.count();
  console.log(`   count before/after: ${beforeCount} / ${afterCount} (expected equal)`);

  console.log('4) list() via replica');
  console.log('   ', await query.list());

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
