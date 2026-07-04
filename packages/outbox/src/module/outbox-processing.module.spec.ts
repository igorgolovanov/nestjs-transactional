import { randomUUID } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { EventPublicationProcessor } from '../dispatcher/event-publication-processor';
import { OutboxRetryScheduler } from '../recovery/outbox-retry-scheduler';
import { StalenessMonitor } from '../recovery/staleness-monitor';

import { OutboxProcessingModule } from './outbox-processing.module';
import { OutboxModule } from './outbox.module';

interface FakeHandle extends TransactionHandle {
  readonly id: string;
  readonly adapterName: string;
}

class FakeAdapter implements TransactionAdapter<FakeHandle> {
  readonly name = 'in-memory';
  readonly dataSourceName = 'default';

  async runInTransaction<T>(
    _options: TransactionOptions,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    const handle: FakeHandle = { id: randomUUID(), adapterName: this.name };
    return fn(handle);
  }

  async runInSavepoint<T>(
    parent: FakeHandle,
    fn: (handle: FakeHandle) => Promise<T>,
  ): Promise<T> {
    return fn(parent);
  }
}

describe('OutboxProcessingModule', () => {
  let module: TestingModule;
  let processorStart: jest.SpyInstance;
  let processorStop: jest.SpyInstance;
  let monitorStart: jest.SpyInstance;
  let monitorStop: jest.SpyInstance;
  let retryStart: jest.SpyInstance;
  let retryStop: jest.SpyInstance;

  beforeEach(async () => {
    OutboxModule.resetForTesting();
    TransactionalModule.resetForTesting();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
          adapter: new FakeAdapter(),
        }),
        OutboxModule.forRoot({
          staleness: { processing: 60_000, monitorInterval: 120_000 },
        }),
        OutboxProcessingModule,
      ],
    }).compile();

    processorStart = jest
      .spyOn(module.get(EventPublicationProcessor), 'start')
      .mockImplementation(() => undefined);
    processorStop = jest
      .spyOn(module.get(EventPublicationProcessor), 'stop')
      .mockResolvedValue(undefined);
    monitorStart = jest
      .spyOn(module.get(StalenessMonitor), 'start')
      .mockImplementation(() => undefined);
    monitorStop = jest
      .spyOn(module.get(StalenessMonitor), 'stop')
      .mockResolvedValue(undefined);
    retryStart = jest
      .spyOn(module.get(OutboxRetryScheduler), 'start')
      .mockImplementation(() => undefined);
    retryStop = jest
      .spyOn(module.get(OutboxRetryScheduler), 'stop')
      .mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await module?.close();
  });

  it('starts the processor and the staleness monitor on bootstrap', async () => {
    await module.init();

    expect(processorStart).toHaveBeenCalledTimes(1);
    expect(monitorStart).toHaveBeenCalledTimes(1);
    // Started unconditionally; the scheduler itself no-ops unless
    // `retry.maxAttempts > 0` (DD-026).
    expect(retryStart).toHaveBeenCalledTimes(1);
  });

  it('stops the processor and the staleness monitor on shutdown', async () => {
    await module.init();
    await module.close();

    expect(processorStop).toHaveBeenCalledTimes(1);
    expect(monitorStop).toHaveBeenCalledTimes(1);
    expect(retryStop).toHaveBeenCalledTimes(1);
  });

  it('awaits every drain before shutdown completes', async () => {
    // The hook used to be synchronous, so NestJS moved on to tearing
    // down providers (the DataSource among them) while a batch was
    // still running. `module.close()` must not resolve until each
    // drain has.
    let processorDrained = false;
    let monitorDrained = false;
    processorStop.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      processorDrained = true;
    });
    monitorStop.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      monitorDrained = true;
    });

    await module.init();
    await module.close();

    expect(processorDrained).toBe(true);
    expect(monitorDrained).toBe(true);
  });
});
