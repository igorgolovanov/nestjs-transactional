import { Global, Inject, Injectable, Module, type Provider } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  ADAPTER_REGISTRY,
  type AdapterRegistry,
  getTransactionalAdapterToken,
  IllegalTransactionStateError,
  Transactional,
  TransactionalModule,
} from '@nestjs-transactional/core';

import { accountIds, accounts, createTestDb, type TestDb } from '../../test/support/pglite.js';
import { DrizzleTransactionAdapter } from '../adapter/drizzle.adapter.js';
import {
  getCurrentDrizzleTransaction,
  isInDrizzleTransaction,
} from '../helpers/get-current-transaction.js';

import { TransactionalDrizzleModule } from './transactional-drizzle.module.js';

const DB = Symbol('DB');
const BILLING_DB = Symbol('BILLING_DB');

/** Where an application would register its own `drizzle()` instances. */
function databaseModule(providers: Provider[]): unknown {
  @Global()
  @Module({
    providers,
    exports: providers.map((p) => (typeof p === 'object' && 'provide' in p ? p.provide : p)),
  })
  class DatabaseModule {}
  return DatabaseModule;
}

@Injectable()
class AccountsService {
  constructor(@Inject(DB) private readonly db: TestDb) {}

  @Transactional()
  async open(id: string, fail = false): Promise<boolean> {
    await this.db.insert(accounts).values({ id, balance: 0 });
    if (fail) {
      throw new Error('rolls back');
    }
    return isInDrizzleTransaction();
  }

  @Transactional()
  async currentTransaction(): Promise<unknown> {
    return getCurrentDrizzleTransaction();
  }
}

describe('TransactionalDrizzleModule', () => {
  let db: TestDb;
  let app: TestingModule | undefined;

  beforeEach(async () => {
    TransactionalModule.resetForTesting();
    TransactionalDrizzleModule.resetForTesting();
    db = await createTestDb();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await db.$client.close();
  });

  async function compile(imports: unknown[], providers: Provider[] = []): Promise<TestingModule> {
    app = await Test.createTestingModule({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      imports: imports as any[],
      providers,
    }).compile();
    await app.init();
    return app;
  }

  it('registers a drizzle adapter for the default dataSource', async () => {
    const moduleRef = await compile([
      databaseModule([{ provide: DB, useValue: db }]),
      TransactionalModule.forRoot({ isGlobal: true }),
      TransactionalDrizzleModule.forRoot({ db: DB }),
    ]);

    const adapter = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY).get('drizzle', 'default');
    expect(adapter).toBeInstanceOf(DrizzleTransactionAdapter);
    expect(moduleRef.get(getTransactionalAdapterToken('default'))).toBe(adapter);
  });

  it('makes the injected db join @Transactional, and roll back with it', async () => {
    const moduleRef = await compile(
      [
        databaseModule([{ provide: DB, useValue: db }]),
        TransactionalModule.forRoot({ isGlobal: true }),
        TransactionalDrizzleModule.forRoot({ db: DB }),
      ],
      [AccountsService],
    );
    const service = moduleRef.get(AccountsService);

    await expect(service.open('a')).resolves.toBe(true);
    await expect(service.open('b', true)).rejects.toThrow('rolls back');

    expect(await accountIds(db)).toEqual(['a']);
    expect(isInDrizzleTransaction()).toBe(false);
  });

  it("hands out the transaction's tx through getCurrentDrizzleTransaction", async () => {
    const moduleRef = await compile(
      [
        databaseModule([{ provide: DB, useValue: db }]),
        TransactionalModule.forRoot({ isGlobal: true }),
        TransactionalDrizzleModule.forRoot({ db: DB }),
      ],
      [AccountsService],
    );

    const tx = await moduleRef.get(AccountsService).currentTransaction();

    expect(tx).not.toBe(db);
    expect(typeof (tx as TestDb).insert).toBe('function');
  });

  it('registers several databases, each under its dataSource name', async () => {
    const billing = await createTestDb();
    try {
      const moduleRef = await compile([
        databaseModule([
          { provide: DB, useValue: db },
          { provide: BILLING_DB, useValue: billing },
        ]),
        TransactionalModule.forRoot({ isGlobal: true }),
        TransactionalDrizzleModule.forRoot({ db: DB }),
        TransactionalDrizzleModule.forRoot({
          db: BILLING_DB,
          dataSource: 'billing',
          isDefault: true,
        }),
      ]);

      const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
      expect(registry.get('drizzle', 'default').dataSourceName).toBe('default');
      expect(registry.get('drizzle', 'billing').dataSourceName).toBe('billing');
      expect(registry.getDefaultInstanceName()).toBe('billing');
    } finally {
      await billing.$client.close();
    }
  });

  it('forRootAsync registers the adapter from options resolved at bootstrap', async () => {
    const moduleRef = await compile(
      [
        databaseModule([{ provide: DB, useValue: db }]),
        TransactionalModule.forRoot({ isGlobal: true }),
        TransactionalDrizzleModule.forRootAsync({
          useFactory: async () => {
            await Promise.resolve();
            return { db: DB, dataSource: 'async', isDefault: true };
          },
        }),
      ],
      [AccountsService],
    );

    const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
    expect(registry.get('drizzle', 'async')).toBeInstanceOf(DrizzleTransactionAdapter);
    expect(registry.getDefaultInstanceName()).toBe('async');
  });

  describe('helpers outside a transaction', () => {
    it('getCurrentDrizzleTransaction falls back to the db it is given', () => {
      expect(getCurrentDrizzleTransaction('default', db)).toBe(db);
    });

    it('getCurrentDrizzleTransaction throws with no fallback', () => {
      expect(() => getCurrentDrizzleTransaction('billing')).toThrow(IllegalTransactionStateError);
      expect(() => getCurrentDrizzleTransaction('billing')).toThrow(/drizzle:billing/);
    });

    it('isInDrizzleTransaction is false', () => {
      expect(isInDrizzleTransaction('default')).toBe(false);
    });
  });
});
