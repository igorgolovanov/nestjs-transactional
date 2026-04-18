import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { TypeOrmTransactionalModule } from '@nestjs-transactional/typeorm';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { ArticleQueryService } from '../src/article.query-service';
import { ArticleRow } from '../src/article.entity';
import { ArticleService } from '../src/article.service';

describe('read-write-separation (Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let module: TestingModule;
  let masterDs: DataSource;
  let replicaDs: DataSource;
  let articles: ArticleService;
  let query: ArticleQueryService;

  beforeAll(async () => {
    TransactionalModule.resetForTesting();
    TypeOrmTransactionalModule.resetForTesting();

    container = await new PostgreSqlContainer('postgres:16-alpine').start();

    // Both DSes point at the SAME physical database so the example's
    // demonstration of "writes through master become visible via
    // replica" is observable. In production each DataSource would
    // connect to its own host (master / read replica with streaming
    // replication). The framework wiring is identical either way —
    // the entity registrations, the @Transactional binding, the
    // `@InjectRepository(ArticleRow, 'replica')` token. Only the
    // `host` differs.
    const conn = {
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    };

    module = await Test.createTestingModule({
      imports: [AppModule.forConfig({ master: conn, replica: conn })],
    }).compile();

    await module.init();

    masterDs = module.get<DataSource>(getDataSourceToken());
    replicaDs = module.get<DataSource>(getDataSourceToken('replica'));
    articles = module.get(ArticleService);
    query = module.get(ArticleQueryService);
  }, 90_000);

  afterAll(async () => {
    await module.close();
    await container.stop();
  });

  beforeEach(async () => {
    await masterDs.getRepository(ArticleRow).clear();
  });

  it('write via master + read via replica: created article is visible from the query service', async () => {
    await articles.create('a-1', 'hello', 'world');

    const fromReplica = await query.getById('a-1');
    expect(fromReplica?.title).toBe('hello');
    expect(fromReplica?.body).toBe('world');
  });

  it('write rollback: createAndFail throws; replica count and master count agree (zero)', async () => {
    await expect(articles.createAndFail('a-rollback', 't', 'b')).rejects.toThrow('simulated');

    expect(await query.count()).toBe(0);
    expect(await masterDs.getRepository(ArticleRow).count()).toBe(0);
  });

  it('repository binding: ArticleQueryService got the replica DS repo, not the master one', async () => {
    // Crisp DI assertion: the `Repository` instance injected into
    // ArticleQueryService comes from the replica DataSource, not the
    // master. Without the second argument to `@InjectRepository`,
    // both services would receive the master repo and the
    // read/write split would be a fiction.
    const masterRepo = masterDs.getRepository(ArticleRow);
    const replicaRepo = replicaDs.getRepository(ArticleRow);

    // Tap into the private to confirm — typed via cast because the
    // field is private; we accept the locality for one assertion.
    const injected = (query as unknown as { articles: typeof masterRepo }).articles;

    expect(injected).toBe(replicaRepo);
    expect(injected).not.toBe(masterRepo);
  });

  it('cross-session isolation: a write inside an in-flight master transaction is NOT visible from the replica', async () => {
    // Master and replica DataSources have separate connection pools
    // and therefore separate sessions. Postgres default READ
    // COMMITTED means a SELECT in session B does not see uncommitted
    // writes from session A — even when both sessions point at the
    // same physical database, as in this test.
    //
    // We drop to `masterDs.transaction(...)` (rather than the
    // service) so we can read from the replica MID-FLIGHT, before
    // the master transaction has committed.

    await masterDs.transaction(async (mgr) => {
      await mgr.insert(ArticleRow, { id: 'a-mid', title: 't', body: 'b', viewCount: 0 });

      // Mid-flight replica read — the row is invisible because the
      // master transaction has not committed yet.
      expect(await query.getById('a-mid')).toBeNull();
    });

    // After commit, the replica sees the row.
    expect(await query.getById('a-mid')).not.toBeNull();
  });
});
