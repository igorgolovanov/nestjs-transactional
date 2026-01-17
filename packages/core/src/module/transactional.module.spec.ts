import { Controller, Get, type INestApplication, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { Transactional } from '../decorators/transactional.decorator';
import { ADAPTER_REGISTRY, AdapterRegistry } from '../manager/adapter.registry';
import { TransactionManager } from '../manager/transaction.manager';
import { InMemoryTransactionAdapter } from '../testing/in-memory.adapter';
import { PropagationMode } from '../types/propagation';

import { TransactionalModule } from './transactional.module';

@Injectable()
class UserService {
  async loadUser(id: number): Promise<{ id: number; name: string }> {
    return { id, name: `User ${id}` };
  }
}

@Controller()
class UserController {
  constructor(private readonly users: UserService) {}

  @Get('/users/:id')
  @Transactional()
  async findUser(): Promise<{ id: number; name: string }> {
    return this.users.loadUser(42);
  }

  @Get('/users-new')
  @Transactional({ propagation: PropagationMode.REQUIRES_NEW, isolation: 'SERIALIZABLE' })
  async findUserInNewTx(): Promise<{ id: number; name: string }> {
    return this.users.loadUser(1);
  }

  @Get('/plain')
  async plainHandler(): Promise<string> {
    return 'ok';
  }
}

describe('TransactionalModule (integration)', () => {
  describe('forRoot — full NestApplication with APP_INTERCEPTOR', () => {
    let adapter: InMemoryTransactionAdapter;
    let nestApp: INestApplication;

    beforeEach(async () => {
      adapter = new InMemoryTransactionAdapter();

      const moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
          }),
        ],
        controllers: [UserController],
        providers: [UserService],
      }).compile();

      nestApp = moduleRef.createNestApplication();
      await nestApp.init();
    });

    afterEach(async () => {
      await nestApp.close();
    });

    it('wraps a @Transactional controller handler in a transaction via APP_INTERCEPTOR', async () => {
      const response = await request(nestApp.getHttpServer()).get('/users/42').expect(200);

      expect(response.body).toEqual({ id: 42, name: 'User 42' });
      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
    });

    it('forwards explicit decorator options to the adapter', async () => {
      await request(nestApp.getHttpServer()).get('/users-new').expect(200);

      expect(adapter.committedTransactions).toHaveLength(1);
      expect(adapter.committedTransactions[0]?.options.isolation).toBe('SERIALIZABLE');
    });

    it('does not wrap an undecorated handler', async () => {
      await request(nestApp.getHttpServer()).get('/plain').expect(200);

      expect(adapter.committedTransactions).toHaveLength(0);
      expect(adapter.rolledBackTransactions).toHaveLength(0);
    });
  });

  describe('forRoot — module wiring', () => {
    it('exports TransactionManager and ADAPTER_REGISTRY', async () => {
      const adapter = new InMemoryTransactionAdapter();
      const moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
          }),
        ],
      }).compile();

      const manager = moduleRef.get(TransactionManager);
      const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);

      expect(manager).toBeInstanceOf(TransactionManager);
      expect(registry).toBeInstanceOf(AdapterRegistry);
      expect(registry.get('in-memory', 'default')).toBe(adapter);

      await moduleRef.close();
    });

    it('registers multiple adapters with the first becoming the default', async () => {
      const primary = new InMemoryTransactionAdapter();
      const billing = new InMemoryTransactionAdapter();

      const moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            adapters: [
              { adapterName: 'in-memory', instanceName: 'primary', adapter: primary },
              { adapterName: 'in-memory', instanceName: 'billing', adapter: billing },
            ],
          }),
        ],
      }).compile();

      const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
      const manager = moduleRef.get(TransactionManager);

      expect(registry.getDefaultInstanceName()).toBe('primary');

      await manager.run({ adapterInstance: 'billing' }, async () => {
        // run on billing instance
      });

      expect(billing.committedTransactions).toHaveLength(1);
      expect(primary.committedTransactions).toHaveLength(0);

      await moduleRef.close();
    });

    it('respects registerInterceptor: false — module still wires manager + registry', async () => {
      const adapter = new InMemoryTransactionAdapter();
      const moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRoot({
            registerInterceptor: false,
            adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
          }),
        ],
      }).compile();

      const manager = moduleRef.get(TransactionManager);
      await manager.run({}, async () => {});

      expect(adapter.committedTransactions).toHaveLength(1);

      await moduleRef.close();
    });
  });

  describe('forRootAsync', () => {
    it('receives adapters from the async factory', async () => {
      const adapter = new InMemoryTransactionAdapter();

      const moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRootAsync({
            useFactory: () =>
              Promise.resolve({
                adapters: [{ adapterName: 'in-memory', instanceName: 'default', adapter }],
              }),
          }),
        ],
      }).compile();

      const manager = moduleRef.get(TransactionManager);
      await manager.run({}, async () => {});

      expect(adapter.committedTransactions).toHaveLength(1);

      await moduleRef.close();
    });

    it('supports injecting providers from an imported module into the factory', async () => {
      const CONFIG_TOKEN = 'CONFIG';
      const adapter = new InMemoryTransactionAdapter();

      @Module({
        providers: [{ provide: CONFIG_TOKEN, useValue: { instanceName: 'primary' } }],
        exports: [CONFIG_TOKEN],
      })
      class ConfigModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [
          TransactionalModule.forRootAsync({
            imports: [ConfigModule],
            inject: [CONFIG_TOKEN],
            useFactory: (...args: never[]) => {
              const [cfg] = args as unknown as [{ instanceName: string }];
              return {
                adapters: [{ adapterName: 'in-memory', instanceName: cfg.instanceName, adapter }],
              };
            },
          }),
        ],
      }).compile();

      const registry = moduleRef.get<AdapterRegistry>(ADAPTER_REGISTRY);
      expect(registry.getDefaultInstanceName()).toBe('primary');

      await moduleRef.close();
    });
  });
});
