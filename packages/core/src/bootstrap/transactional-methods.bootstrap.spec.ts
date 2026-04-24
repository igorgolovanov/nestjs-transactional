import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { Transactional } from '../decorators/transactional.decorator';
import { WRAPPED_MARKER } from '../internal/markers';
import { TransactionManager } from '../manager/transaction.manager';
import { TransactionalModule } from '../module/transactional.module';
import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter';

@Injectable()
class UserService {
  @Transactional()
  async createUser(): Promise<string> {
    return 'created';
  }

  async plain(): Promise<string> {
    return 'plain';
  }
}

@Injectable()
@Transactional()
class WholeClassTransactionalService {
  async doA(): Promise<string> {
    return 'A';
  }

  async doB(): Promise<string> {
    return 'B';
  }
}

@Injectable()
class UnrelatedService {
  async work(): Promise<string> {
    return 'unrelated';
  }
}

describe('TransactionalMethodsBootstrap', () => {
  let adapter: InMemoryTransactionAdapter;

  beforeEach(() => {
    adapter = new InMemoryTransactionAdapter();
  });

  const buildModule = async (): Promise<TestingModule> => {
    const module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
          registerInterceptor: false,
        }),
      ],
      providers: [UserService, WholeClassTransactionalService, UnrelatedService],
    }).compile();
    await module.init();
    return module;
  };

  it('wraps a service method annotated with @Transactional — calling it opens a real transaction', async () => {
    const module = await buildModule();
    const service = module.get(UserService);

    const result = await service.createUser();

    expect(result).toBe('created');
    expect(adapter.committedTransactions).toHaveLength(1);

    await module.close();
  });

  it('does NOT wrap an undecorated method on the same service', async () => {
    const module = await buildModule();
    const service = module.get(UserService);

    const result = await service.plain();

    expect(result).toBe('plain');
    expect(adapter.committedTransactions).toHaveLength(0);

    await module.close();
  });

  it('applies class-level @Transactional to every method of the class', async () => {
    const module = await buildModule();
    const service = module.get(WholeClassTransactionalService);

    await service.doA();
    await service.doB();

    expect(adapter.committedTransactions).toHaveLength(2);

    await module.close();
  });

  it('does NOT wrap services that carry no transactional metadata at all', async () => {
    const module = await buildModule();
    const unrelated = module.get(UnrelatedService);

    await unrelated.work();

    expect(adapter.committedTransactions).toHaveLength(0);

    await module.close();
  });

  it('tags wrapped methods with WRAPPED_MARKER so other wrapping mechanisms skip them', async () => {
    const module = await buildModule();
    const service = module.get(UserService);
    const host = service as unknown as Record<string, unknown>;

    const wrappedMethod = host.createUser;
    expect(typeof wrappedMethod).toBe('function');
    expect(Reflect.getMetadata(WRAPPED_MARKER, wrappedMethod as object)).toBe(true);

    await module.close();
  });

  it('honours options.registerMethodsBootstrap=false — service methods remain unwrapped', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
          registerInterceptor: false,
          registerMethodsBootstrap: false,
        }),
      ],
      providers: [UserService],
    }).compile();
    await module.init();

    const service = module.get(UserService);
    await service.createUser();

    expect(adapter.committedTransactions).toHaveLength(0);

    await module.close();
  });
});

describe('TransactionalMethodsBootstrap + TransactionManager coordination', () => {
  it('wrapped method promises resolve with the original return value', async () => {
    const adapter = new InMemoryTransactionAdapter();
    const module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
          registerInterceptor: false,
        }),
      ],
      providers: [UserService],
    }).compile();
    await module.init();

    const service = module.get(UserService);
    const returned = await service.createUser();
    expect(returned).toBe('created');

    await module.close();
  });

  it('TransactionManager is callable directly from the same module', async () => {
    const adapter = new InMemoryTransactionAdapter();
    const module = await Test.createTestingModule({
      imports: [
        TransactionalModule.forRoot({
          isGlobal: true,
          adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
          registerInterceptor: false,
        }),
      ],
    }).compile();
    await module.init();

    const manager = module.get(TransactionManager);
    await manager.run({}, async () => undefined);

    expect(adapter.committedTransactions).toHaveLength(1);
    await module.close();
  });
});
