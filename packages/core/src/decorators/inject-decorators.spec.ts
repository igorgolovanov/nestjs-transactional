import 'reflect-metadata';

import {
  InjectTransactionContext,
  InjectTransactionManager,
  InjectTransactionalAdapter,
} from './inject-decorators';

/**
 * `@Inject(token)` writes its token under the
 * `'self:paramtypes'` key on the *constructor* (NestJS internal
 * convention — the same key its DI container reads to resolve
 * constructor parameters). The shape is
 * `[{ index: number, param: token }]`. We assert against the array
 * directly rather than spinning up a NestJS module — the goal is to
 * pin the exact token string the decorator produced.
 */
function readSelfParamTypes(target: unknown): { index: number; param: unknown }[] {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
  return Reflect.getMetadata('self:paramtypes', target as any) ?? [];
}

describe('Inject decorators (core)', () => {
  describe('InjectTransactionManager', () => {
    it('binds the default-dataSource token when no argument is passed', () => {
      class TestClass {
        constructor(
          @InjectTransactionManager()
          readonly mgr: unknown,
        ) {}
      }

      const params = readSelfParamTypes(TestClass);
      expect(params).toHaveLength(1);
      expect(params[0]!.index).toBe(0);
      expect(params[0]!.param).toBe('defaultTransactionManager');
    });

    it('binds the supplied-dataSource token', () => {
      class TestClass {
        constructor(
          @InjectTransactionManager('billing')
          readonly mgr: unknown,
        ) {}
      }

      const params = readSelfParamTypes(TestClass);
      expect(params[0]!.param).toBe('billingTransactionManager');
    });

    it('produces distinct tokens for distinct dataSources on the same constructor', () => {
      class TestClass {
        constructor(
          @InjectTransactionManager() readonly defaultMgr: unknown,
          @InjectTransactionManager('billing') readonly billingMgr: unknown,
          @InjectTransactionManager('inventory') readonly inventoryMgr: unknown,
        ) {}
      }

      const params = readSelfParamTypes(TestClass);
      const tokens = params.map((p) => p.param).sort();
      expect(tokens).toEqual([
        'billingTransactionManager',
        'defaultTransactionManager',
        'inventoryTransactionManager',
      ]);
    });
  });

  describe('InjectTransactionContext', () => {
    it('binds the per-dataSource context token', () => {
      class TestClass {
        constructor(
          @InjectTransactionContext('audit')
          readonly ctx: unknown,
        ) {}
      }

      expect(readSelfParamTypes(TestClass)[0]!.param).toBe('auditTransactionContext');
    });
  });

  describe('InjectTransactionalAdapter', () => {
    it('binds the per-dataSource adapter token', () => {
      class TestClass {
        constructor(
          @InjectTransactionalAdapter('reporting')
          readonly adapter: unknown,
        ) {}
      }

      expect(readSelfParamTypes(TestClass)[0]!.param).toBe(
        'reportingTransactionalAdapter',
      );
    });
  });
});
