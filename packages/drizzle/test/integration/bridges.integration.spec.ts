import 'reflect-metadata';

import { jest } from '@jest/globals';
import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import {
  AggregateRoot,
  CommandBus,
  CommandHandler,
  EventPublisher,
  type ICommandHandler,
} from '@nestjs/cqrs';
import { OutboxModule, OutboxStorage } from '@nestjs/outbox';
import { fromDrizzle, PostgresOutboxStore } from '@nestjs/outbox/postgres';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  Workflow,
  WorkflowClient,
  type WorkflowContext,
  type WorkflowRunner,
  WorkflowSignal,
  WorkflowsModule,
  WorkflowStorage,
} from '@nestjs/workflows';
import { StartOn, WorkflowsCqrsModule } from '@nestjs/workflows/cqrs';
import { PostgresWorkflowStore } from '@nestjs/workflows/postgres';
import { Transactional, TransactionalModule } from '@nestjs-transactional/core';
import { TransactionalCqrsModule } from '@nestjs-transactional/cqrs';
import { Externalized, TransactionalOutboxModule } from '@nestjs-transactional/outbox';
import {
  TransactionalWorkflowsModule,
  WorkflowIsolationError,
} from '@nestjs-transactional/workflows';

import { TransactionalDrizzleModule } from '../../src/index.js';
import { accounts } from '../support/pglite.js';
import {
  type ConnectedDb,
  type IntegrationDb,
  type PostgresContext,
  startPostgres,
} from '../support/postgres.js';

const DB = Symbol('DB');

@Externalized<AccountOpened>({ target: 'accounts.opened', client: 'local' })
class AccountOpened {
  constructor(readonly accountId: string) {}
}

const deposited = new WorkflowSignal<{ readonly amount: number }>('account.deposited');
const onboardingId = (accountId: string): string => `onboard-${accountId}`;

/** Started by `AccountOpened`; parks until the first deposit. */
@StartOn(AccountOpened, { id: (e) => onboardingId(e.accountId), input: (e) => e })
@Workflow('onboard-account')
class OnboardAccount implements WorkflowRunner<AccountOpened, number> {
  async run(ctx: WorkflowContext, input: AccountOpened): Promise<number> {
    const deposit = await ctx.waitForSignal('first-deposit', deposited, {
      key: input.accountId,
      timeout: '1h',
    });
    return deposit?.amount ?? 0;
  }
}

class Account extends AggregateRoot {
  constructor(readonly id: string) {
    super();
  }
  open(): void {
    this.apply(new AccountOpened(this.id));
  }
}

class OpenAccount {
  constructor(
    readonly accountId: string,
    readonly fail = false,
  ) {}
}

/** One @Transactional command: a Drizzle write, then an aggregate event. */
@CommandHandler(OpenAccount)
@Injectable()
class OpenAccountHandler implements ICommandHandler<OpenAccount> {
  constructor(
    @Inject(DB) private readonly db: IntegrationDb,
    private readonly publisher: EventPublisher,
  ) {}

  @Transactional()
  async execute(command: OpenAccount): Promise<void> {
    await this.db.insert(accounts).values({ id: command.accountId, balance: 0 });
    const account = this.publisher.mergeObjectContext(new Account(command.accountId));
    account.open();
    account.commit();
    if (command.fail) {
      throw new Error('forced rollback');
    }
  }
}

@Injectable()
class Deposits {
  constructor(
    @Inject(DB) private readonly db: IntegrationDb,
    private readonly workflows: WorkflowClient,
  ) {}

  @Transactional()
  async deposit(accountId: string, amount: number, fail = false): Promise<void> {
    await this.db.update(accounts).set({ balance: amount });
    await this.workflows.signal(deposited, { amount }, { key: accountId });
    if (fail) {
      throw new Error('forced rollback');
    }
  }

  @Transactional({ isolation: 'SERIALIZABLE' })
  async depositSerializable(accountId: string, amount: number): Promise<void> {
    await this.db.update(accounts).set({ balance: amount });
    await this.workflows.signal(deposited, { amount }, { key: accountId });
  }
}

/**
 * The bridges on a Drizzle database: `@nestjs/outbox` and
 * `@nestjs/workflows` with their PostgreSQL stores on `fromDrizzle(db)`,
 * `@nestjs/cqrs` through `TransactionalCqrsModule`, and
 * `TransactionalDrizzleModule` making the injected db and the bridges
 * share the transaction `@Transactional` opened. Nothing in the
 * application passes a transaction.
 */
describe('the reliability bridges on Drizzle (testcontainers)', () => {
  let pgctx: PostgresContext;
  let connected: ConnectedDb;
  let app: TestingModule;
  let commands: CommandBus;
  let workflows: WorkflowClient;
  let deposits: Deposits;

  const outboxTopics = async (): Promise<string[]> =>
    (
      await pgctx.committed<{ topic: string }>(
        'SELECT topic FROM nest_outbox.messages ORDER BY seq',
      )
    ).map((row) => row.topic);
  const status = async (accountId: string): Promise<string | undefined> =>
    ((await workflows.getStatus(onboardingId(accountId))) as { status?: string } | null)?.status;

  async function waitForStatus(accountId: string, expected: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await status(accountId)) === expected) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`onboarding of ${accountId} never became ${expected}`);
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    pgctx = await startPostgres();
    connected = await pgctx.connect('node-postgres');
    TransactionalModule.resetForTesting();
    TransactionalDrizzleModule.resetForTesting();

    @Global()
    @Module({ providers: [{ provide: DB, useValue: connected.db }], exports: [DB] })
    class DatabaseModule {}

    app = await Test.createTestingModule({
      imports: [
        DatabaseModule,
        TransactionalModule.forRoot({ isGlobal: true, registerInterceptor: false }),
        TransactionalDrizzleModule.forRoot({ db: DB }),
        TransactionalCqrsModule.forRoot(),
        OutboxModule.forRoot({ relay: { enabled: false } }),
        TransactionalOutboxModule.forRoot(),
        WorkflowsModule.forRoot({ worker: { pollInterval: '50ms' } }),
        WorkflowsCqrsModule,
        TransactionalWorkflowsModule.forRoot(),
      ],
      providers: [
        OnboardAccount,
        OpenAccountHandler,
        Deposits,
        {
          provide: PostgresOutboxStore,
          inject: [DB, OutboxStorage],
          useFactory: (db: IntegrationDb, storage: OutboxStorage) =>
            new PostgresOutboxStore({ executor: fromDrizzle(db) }, storage),
        },
        {
          provide: PostgresWorkflowStore,
          inject: [DB, WorkflowStorage],
          useFactory: (db: IntegrationDb, storage: WorkflowStorage) =>
            new PostgresWorkflowStore({ executor: fromDrizzle(db) }, storage),
        },
      ],
    }).compile();
    await app.init();

    commands = app.get(CommandBus);
    workflows = app.get(WorkflowClient);
    deposits = app.get(Deposits);
  });

  afterAll(async () => {
    await app?.close();
    await connected?.close();
    await pgctx?.container.stop();
    jest.restoreAllMocks();
  });

  it('commits the row, the @StartOn workflow and the outbox message together', async () => {
    await commands.execute(new OpenAccount('a-1'));

    expect(await pgctx.committedIds()).toEqual(['a-1']);
    expect(await workflows.getStatus(onboardingId('a-1'))).not.toBeNull();
    expect(await outboxTopics()).toEqual(['accounts.opened']);
  });

  it('rolls the row, the workflow and the outbox message back together', async () => {
    await expect(commands.execute(new OpenAccount('a-2', true))).rejects.toThrow('forced rollback');

    expect(await pgctx.committedIds()).toEqual(['a-1']);
    expect(await workflows.getStatus(onboardingId('a-2'))).toBeNull();
    expect(await outboxTopics()).toEqual(['accounts.opened']);
  });

  it('rolls a signal back with the write, and the workflow keeps waiting', async () => {
    await waitForStatus('a-1', 'suspended');

    await expect(deposits.deposit('a-1', 100, true)).rejects.toThrow('forced rollback');

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await status('a-1')).toBe('suspended');
  });

  it('refuses a signal under SERIALIZABLE before anything is written', async () => {
    await expect(deposits.depositSerializable('a-1', 100)).rejects.toThrow(WorkflowIsolationError);
    expect(await status('a-1')).toBe('suspended');
  });

  it('commits a signal with the write, and the workflow completes', async () => {
    await deposits.deposit('a-1', 250);

    expect(await workflows.result(onboardingId('a-1'), { timeout: '20s' })).toBe(250);
  });
});
