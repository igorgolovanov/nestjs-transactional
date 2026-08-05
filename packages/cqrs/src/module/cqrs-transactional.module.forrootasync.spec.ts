import { randomUUID } from 'node:crypto';

import { type DynamicModule, Injectable, Logger, Module, type Provider } from '@nestjs/common';
import { EventPublisher } from '@nestjs/cqrs';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  TransactionalModule,
  type TransactionAdapter,
  type TransactionHandle,
  type TransactionOptions,
} from '@nestjs-transactional/core';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';
import { HybridEventPublisher } from '../event-publisher/hybrid-event-publisher';
import { CqrsHandlerWrapper, type HandlerWrapperOptions } from '../handlers/handler-wrapper';

import { CQRS_TRANSACTIONAL_OPTIONS, CqrsTransactionalModule } from './cqrs-transactional.module';

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

describe('CqrsTransactionalModule.forRootAsync', () => {
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
      CqrsTransactionalModule.forRootAsync({
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

    const options = built.get<HandlerWrapperOptions>(CQRS_TRANSACTIONAL_OPTIONS);

    expect(options.wrapCommandHandlers).toBe(false);
    expect(options.wrapEventHandlers).toBe(false);
    expect(options.defaultCommandOptions).toEqual({ timeout: 1234 });
  });

  it('applies the same defaults as forRoot when the factory returns nothing', async () => {
    const built = await build([
      CqrsTransactionalModule.forRootAsync({
        useFactory: () => ({}),
      }),
    ]);

    const options = built.get<HandlerWrapperOptions>(CQRS_TRANSACTIONAL_OPTIONS);

    expect(options).toMatchObject({
      wrapCommandHandlers: true,
      wrapQueryHandlers: true,
      wrapEventHandlers: true,
      defaultQueryOptions: { readOnly: true },
    });
  });

  it('injects dependencies into the factory', async () => {
    const built = await build([
      CqrsTransactionalModule.forRootAsync({
        imports: [ConfigFixtureModule],
        inject: [FakeConfig],
        useFactory: (config: FakeConfig) => ({ wrapQueryHandlers: config.wrapQueries }),
      }),
    ]);

    const options = built.get<HandlerWrapperOptions>(CQRS_TRANSACTIONAL_OPTIONS);

    expect(options.wrapQueryHandlers).toBe(false);
  });

  describe('useTransactionalEventPublisher', () => {
    // Structural, so it stays on the options object rather than the
    // factory result: it decides whether the `EventPublisher` override
    // provider exists at all, and NestJS needs provider tokens at
    // module-build time (same constraint as convention #21).
    //
    // Asserted on the DynamicModule the call returns, not via
    // `module.get(EventPublisher)`. A non-strict `get` from the root
    // scope finds `CqrsModule`'s own `EventPublisher` rather than the
    // override — the override reaches consumers through this module's
    // `exports`, which is also why a duplicate `CqrsModule` import
    // shadows it (convention #6). Behavioural coverage of the override
    // lives in the E2E spec.

    function publisherProviderOf(built: DynamicModule): Provider | undefined {
      return built.providers?.find(
        (p): p is Provider =>
          typeof p === 'object' && 'provide' in p && p.provide === EventPublisher,
      );
    }

    it('registers and exports the override by default', () => {
      const built = CqrsTransactionalModule.forRootAsync({ useFactory: () => ({}) });

      expect(publisherProviderOf(built)).toBeDefined();
      expect(built.exports).toContain(EventPublisher);
      expect(built.exports).toContain(HybridEventPublisher);
    });

    it('registers neither when disabled', () => {
      const built = CqrsTransactionalModule.forRootAsync({
        useTransactionalEventPublisher: false,
        useFactory: () => ({}),
      });

      expect(publisherProviderOf(built)).toBeUndefined();
      expect(built.exports).not.toContain(EventPublisher);
      expect(built.exports).toContain(TransactionalEventDispatcher);
    });

    it('matches what forRoot produces', () => {
      // The two paths differ only in how CQRS_TRANSACTIONAL_OPTIONS is
      // provided; the rest of the provider matrix must stay identical,
      // or the async path silently loses wiring.
      const sync = CqrsTransactionalModule.forRoot();
      const async = CqrsTransactionalModule.forRootAsync({ useFactory: () => ({}) });

      expect(async.exports).toEqual(sync.exports);
      expect(async.providers).toHaveLength(sync.providers?.length ?? 0);
    });
  });

  it('resolves the wrapper it wired', async () => {
    // Regression guard for the `exports: exportTokens as never[]` smell
    // the typed exports array replaced.
    const built = await build([CqrsTransactionalModule.forRootAsync({ useFactory: () => ({}) })]);

    expect(built.get(CqrsHandlerWrapper)).toBeInstanceOf(CqrsHandlerWrapper);
    expect(built.get(TransactionalEventDispatcher)).toBeInstanceOf(TransactionalEventDispatcher);
  });
});
