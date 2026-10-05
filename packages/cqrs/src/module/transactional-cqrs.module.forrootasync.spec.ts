import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { type DynamicModule, Injectable, Logger, Module } from '@nestjs/common';
import { CqrsModule, EventBus } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher.js';
import { TransactionalEventBusPublisher } from '../event-publisher/transactional-event-bus-publisher.js';
import { CqrsHandlerWrapper, type HandlerWrapperOptions } from '../handlers/handler-wrapper.js';

import {
  TRANSACTIONAL_CQRS_OPTIONS,
  TransactionalCqrsModule,
} from './transactional-cqrs.module.js';

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
    return fn({ id: randomUUID(), adapterName: this.name });
  }

  async runInSavepoint<T>(parent: FakeHandle, fn: (handle: FakeHandle) => Promise<T>): Promise<T> {
    return fn(parent);
  }
}

/** Stand-in for a `ConfigService`-style async dependency. */
@Injectable()
class FakeConfig {
  readonly wrapQueries = false;
}

@Module({ providers: [FakeConfig], exports: [FakeConfig] })
class ConfigFixtureModule {}

describe('TransactionalCqrsModule.forRootAsync', () => {
  let module: TestingModule | undefined;

  beforeEach(() => {
    TransactionalModule.resetForTesting();
    CqrsHandlerWrapper.resetForTesting();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await module?.close();
    module = undefined;
  });

  async function build(
    imports: Parameters<typeof Test.createTestingModule>[0]['imports'],
  ): Promise<TestingModule> {
    module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          registerInterceptor: false,
          registerMethodsBootstrap: false,
          adapter: new FakeAdapter(),
        }),
        ...(imports ?? []),
      ],
    }).compile();
    await module.init();
    return module;
  }

  it('resolves wrapper options from the async factory', async () => {
    const built = await build([
      TransactionalCqrsModule.forRootAsync({
        useFactory: async () => {
          await Promise.resolve();
          return {
            wrapCommandHandlers: false,
            wrapEventHandlers: false,
            defaultCommandOptions: { timeout: 1234 },
          };
        },
      }),
    ]);

    const options = built.get<HandlerWrapperOptions>(TRANSACTIONAL_CQRS_OPTIONS);

    expect(options.wrapCommandHandlers).toBe(false);
    expect(options.wrapEventHandlers).toBe(false);
    expect(options.defaultCommandOptions).toEqual({ timeout: 1234 });
  });

  it('applies the same defaults as forRoot when the factory returns nothing', async () => {
    const built = await build([
      TransactionalCqrsModule.forRootAsync({
        useFactory: () => ({}),
      }),
    ]);

    const options = built.get<HandlerWrapperOptions>(TRANSACTIONAL_CQRS_OPTIONS);

    expect(options).toMatchObject({
      wrapCommandHandlers: true,
      wrapQueryHandlers: true,
      wrapEventHandlers: true,
      defaultQueryOptions: { readOnly: true },
    });
  });

  it('injects dependencies into the factory', async () => {
    const built = await build([
      TransactionalCqrsModule.forRootAsync({
        imports: [ConfigFixtureModule],
        inject: [FakeConfig],
        useFactory: (config: FakeConfig) => ({ wrapQueryHandlers: config.wrapQueries }),
      }),
    ]);

    const options = built.get<HandlerWrapperOptions>(TRANSACTIONAL_CQRS_OPTIONS);

    expect(options.wrapQueryHandlers).toBe(false);
  });

  describe('structural options', () => {
    // `cqrs` and `eventPublisher` shape the module, so they sit beside
    // the factory rather than in its result (convention #21).

    function cqrsModuleOf(built: DynamicModule): DynamicModule | undefined {
      return built.imports?.find(
        (i): i is DynamicModule =>
          typeof i === 'object' && 'module' in i && i.module === CqrsModule,
      );
    }

    it('imports CqrsModule.forRoot() with the transactional publisher and the cqrs options', () => {
      const built = TransactionalCqrsModule.forRootAsync({
        cqrs: { rethrowUnhandled: true },
        useFactory: () => ({}),
      });

      const options = (cqrsModuleOf(built)?.providers?.[0] as { useValue?: unknown }).useValue;
      expect(options).toMatchObject({ rethrowUnhandled: true });
      expect((options as { eventPublisher?: unknown }).eventPublisher).toBeInstanceOf(
        TransactionalEventBusPublisher,
      );
    });

    it('hands events on to the eventPublisher option', async () => {
      const published: unknown[] = [];
      const built = await build([
        TransactionalCqrsModule.forRootAsync({
          eventPublisher: { publish: (event) => void published.push(event) },
          useFactory: () => ({}),
        }),
      ]);

      const event = { name: 'e' };
      await built.get(EventBus).publish(event);

      expect(published).toEqual([event]);
    });

    it('matches what forRoot produces', () => {
      // The two paths differ only in how TRANSACTIONAL_CQRS_OPTIONS is
      // provided; the rest of the provider matrix must stay identical,
      // or the async path silently loses wiring.
      const sync = TransactionalCqrsModule.forRoot();
      const async = TransactionalCqrsModule.forRootAsync({ useFactory: () => ({}) });

      expect(async.exports).toEqual(sync.exports);
      expect(async.providers).toHaveLength(sync.providers?.length ?? 0);
    });
  });

  it('resolves the wrapper it wired', async () => {
    // Regression guard for the `exports: exportTokens as never[]` smell
    // the typed exports array replaced.
    const built = await build([TransactionalCqrsModule.forRootAsync({ useFactory: () => ({}) })]);

    expect(built.get(CqrsHandlerWrapper)).toBeInstanceOf(CqrsHandlerWrapper);
    expect(built.get(TransactionalEventDispatcher)).toBeInstanceOf(TransactionalEventDispatcher);
  });
});
