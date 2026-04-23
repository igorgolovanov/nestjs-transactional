import {
  type CallHandler,
  Controller,
  type ExecutionContext,
  Get,
  Injectable,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { defer, firstValueFrom, from, of, throwError } from 'rxjs';

import { Transactional } from '../decorators/transactional.decorator';
import { ADAPTER_REGISTRY, AdapterRegistry } from '../manager/adapter.registry';
import { TransactionManager } from '../manager/transaction.manager';
import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter';
import { PropagationMode } from '../types/propagation';

import { TransactionalInterceptor } from './transactional.interceptor';

@Injectable()
class TestService {
  async loadUser(): Promise<string> {
    return 'user-42';
  }
}

@Controller()
class TestController {
  constructor(private readonly svc: TestService) {}

  @Get('/work')
  @Transactional()
  async doWork(): Promise<string> {
    return this.svc.loadUser();
  }

  @Get('/work-new')
  @Transactional({ propagation: PropagationMode.REQUIRES_NEW, isolation: 'SERIALIZABLE' })
  async doRequiresNew(): Promise<string> {
    return this.svc.loadUser();
  }

  @Get('/plain')
  async plain(): Promise<string> {
    return this.svc.loadUser();
  }

  @Get('/fail')
  @Transactional()
  async fail(): Promise<string> {
    throw new Error('boom');
  }
}

@Controller()
@Transactional({ propagation: PropagationMode.REQUIRES_NEW })
class TestClassDecoratedController {
  constructor(private readonly svc: TestService) {}

  @Get('/class-level')
  async fromClass(): Promise<string> {
    return this.svc.loadUser();
  }
}

function makeExecutionContext(
  handler: (...args: unknown[]) => unknown,
  cls: new (...args: unknown[]) => unknown,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getType: () => 'http' as const,
    switchToHttp: () => ({}) as never,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
  } as unknown as ExecutionContext;
}

describe('TransactionalInterceptor', () => {
  let adapter: InMemoryTransactionAdapter;
  let moduleRef: TestingModule;
  let interceptor: TransactionalInterceptor;
  let controller: TestController;
  let classDecoratedController: TestClassDecoratedController;

  beforeEach(async () => {
    adapter = new InMemoryTransactionAdapter();
    const registry = new AdapterRegistry();
    registry.register({
      adapterName: 'in-memory',
      instanceName: 'default',
      adapter,
    });

    moduleRef = await Test.createTestingModule({
      controllers: [TestController, TestClassDecoratedController],
      providers: [
        TestService,
        { provide: ADAPTER_REGISTRY, useValue: registry },
        TransactionManager,
        TransactionalInterceptor,
        // Proves the interceptor can be wired as a global APP_INTERCEPTOR.
        { provide: APP_INTERCEPTOR, useExisting: TransactionalInterceptor },
      ],
    }).compile();

    interceptor = moduleRef.get(TransactionalInterceptor);
    controller = moduleRef.get(TestController);
    classDecoratedController = moduleRef.get(TestClassDecoratedController);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('wraps a @Transactional method handler in a transaction', async () => {
    const context = makeExecutionContext(
      TestController.prototype.doWork,
      TestController as unknown as new (...args: unknown[]) => unknown,
    );
    const next: CallHandler = { handle: () => defer(() => from(controller.doWork())) };

    const result = await firstValueFrom(interceptor.intercept(context, next));

    expect(result).toBe('user-42');
    expect(adapter.committedTransactions).toHaveLength(1);
    expect(adapter.rolledBackTransactions).toHaveLength(0);
  });

  it('passes explicit options to the manager (REQUIRES_NEW, isolation SERIALIZABLE)', async () => {
    const context = makeExecutionContext(
      TestController.prototype.doRequiresNew,
      TestController as unknown as new (...args: unknown[]) => unknown,
    );
    const next: CallHandler = { handle: () => of('user-42') };

    await firstValueFrom(interceptor.intercept(context, next));

    expect(adapter.committedTransactions).toHaveLength(1);
    expect(adapter.committedTransactions[0]?.options.isolation).toBe('SERIALIZABLE');
  });

  it('passes a handler without @Transactional through without creating a transaction', async () => {
    const context = makeExecutionContext(
      TestController.prototype.plain,
      TestController as unknown as new (...args: unknown[]) => unknown,
    );
    const next: CallHandler = { handle: () => of('user-42') };

    const result = await firstValueFrom(interceptor.intercept(context, next));

    expect(result).toBe('user-42');
    expect(adapter.committedTransactions).toHaveLength(0);
    expect(adapter.rolledBackTransactions).toHaveLength(0);
  });

  it('falls back to class-level @Transactional when the method has no metadata', async () => {
    const context = makeExecutionContext(
      TestClassDecoratedController.prototype.fromClass,
      TestClassDecoratedController as unknown as new (...args: unknown[]) => unknown,
    );
    const next: CallHandler = {
      handle: () => defer(() => from(classDecoratedController.fromClass())),
    };

    await firstValueFrom(interceptor.intercept(context, next));

    expect(adapter.committedTransactions).toHaveLength(1);
  });

  it('propagates errors from the handler as observable error and rolls back', async () => {
    const context = makeExecutionContext(
      TestController.prototype.fail,
      TestController as unknown as new (...args: unknown[]) => unknown,
    );
    const boom = new Error('boom');
    const next: CallHandler = { handle: () => throwError(() => boom) };

    await expect(firstValueFrom(interceptor.intercept(context, next))).rejects.toBe(boom);

    expect(adapter.rolledBackTransactions).toHaveLength(1);
    expect(adapter.rolledBackTransactions[0]?.error).toBe(boom);
    expect(adapter.committedTransactions).toHaveLength(0);
  });
});
