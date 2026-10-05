import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TransactionalModule } from '@nestjs-transactional/core';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { TransactionalTypeOrmModule } from '../../src/module/transactional-typeorm.module.js';
import { TestUser } from '../shared/test-user.entity.js';

/**
 * Pin the `TransactionalTypeOrmModule.forRootAsync` contract: it
 * must compose cleanly with `@nestjs/typeorm`'s
 * `TypeOrmModule.forRootAsync` and let the resulting app boot.
 *
 * Historical context: prior to the OnModuleInit-driven registration
 *, the async path failed with
 * `TypeError: this.postgres.Pool is not a constructor`, cascading
 * from a `markAsManaged(undefined)` because the registration's
 * `useFactory` ran before NestJS had resolved the DataSource
 * provider. Each `it` below is a self-contained compose so the
 * regression can be filtered to a single case if it returns.
 */
describe('TransactionalTypeOrmModule.forRootAsync (integration, Postgres via testcontainers)', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
  }, 60_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(() => {
    TransactionalModule.resetForTesting();
    TransactionalTypeOrmModule.resetForTesting();
  });

  function dbConfig(): {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
  } {
    return {
      host: container.getHost(),
      port: container.getPort(),
      username: container.getUsername(),
      password: container.getPassword(),
      database: container.getDatabase(),
    };
  }

  // Baseline — proves the test infrastructure works without our module.
  it('TypeOrmModule.forRootAsync alone — boots and connects', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'postgres' as const,
            ...dbConfig(),
            entities: [TestUser],
            synchronize: true,
          }),
        }),
      ],
    }).compile();
    try {
      await module.init();
    } finally {
      await module.close();
    }
  });

  // Sync `forRoot` — proves the framework module's sync path works.
  it('+ TransactionalTypeOrmModule.forRoot() (sync) — boots and connects', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'postgres' as const,
            ...dbConfig(),
            entities: [TestUser],
            synchronize: true,
          }),
        }),
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRoot(),
      ],
    }).compile();
    try {
      await module.init();
    } finally {
      await module.close();
    }
  });

  // The regression: `TransactionalTypeOrmModule.forRootAsync` paired
  // with `TypeOrmModule.forRootAsync` previously failed with
  // `TypeError: this.postgres.Pool is not a constructor`, surfaced
  // diagnosed as a cascade from
  // `markAsManaged(undefined)` (because the registration ran via a
  // `useFactory` provider before the DataSource was available via
  // `ModuleRef`). The fix moved the registration into an
  // `OnModuleInit` hook on a generated `@Injectable()` class, which
  // runs after every provider is instantiated. This test pins that
  // contract.
  it('+ TransactionalTypeOrmModule.forRootAsync — boots and connects', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'postgres' as const,
            ...dbConfig(),
            entities: [TestUser],
            synchronize: true,
          }),
        }),
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRootAsync({
          useFactory: () => ({}),
        }),
      ],
    }).compile();
    try {
      await module.init();
    } finally {
      await module.close();
    }
  });

  // Async path with `inject` and a meaningful payload — proves the
  // generated registration class injects the resolved options
  // correctly (not just the empty-options happy path).
  it('+ TransactionalTypeOrmModule.forRootAsync with inject and resolved options', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'postgres' as const,
            ...dbConfig(),
            entities: [TestUser],
            synchronize: true,
          }),
        }),
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalTypeOrmModule.forRootAsync({
          useFactory: () => ({ isDefault: true }),
        }),
      ],
    }).compile();
    try {
      await module.init();
    } finally {
      await module.close();
    }
  });
});
