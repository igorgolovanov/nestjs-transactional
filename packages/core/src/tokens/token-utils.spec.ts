import {
  getTransactionContextRegistryToken,
  getTransactionContextToken,
  getTransactionManagerToken,
  getTransactionalAdapterToken,
} from './token-utils';

describe('Token utilities (core)', () => {
  describe('getTransactionManagerToken', () => {
    it('defaults to the "default" dataSource when no argument is passed', () => {
      expect(getTransactionManagerToken()).toBe('defaultTransactionManager');
    });

    it('uses the provided dataSource name', () => {
      expect(getTransactionManagerToken('billing')).toBe('billingTransactionManager');
      expect(getTransactionManagerToken('inventory')).toBe('inventoryTransactionManager');
    });

    it('concatenates literally — empty string yields the bare component name', () => {
      // Documented contract: empty string is a programming error at
      // the call site (collides with NestJS's class-token shape). The
      // function does not normalise; this test pins the behaviour.
      expect(getTransactionManagerToken('')).toBe('TransactionManager');
    });

    it('is deterministic — same input yields same output across calls', () => {
      const a = getTransactionManagerToken('billing');
      const b = getTransactionManagerToken('billing');
      expect(a).toBe(b);
    });
  });

  describe('getTransactionContextToken', () => {
    it('defaults to "defaultTransactionContext"', () => {
      expect(getTransactionContextToken()).toBe('defaultTransactionContext');
    });

    it('uses the provided dataSource name', () => {
      expect(getTransactionContextToken('audit')).toBe('auditTransactionContext');
    });
  });

  describe('getTransactionalAdapterToken', () => {
    it('defaults to "defaultTransactionalAdapter"', () => {
      expect(getTransactionalAdapterToken()).toBe('defaultTransactionalAdapter');
    });

    it('uses the provided dataSource name', () => {
      expect(getTransactionalAdapterToken('reporting')).toBe(
        'reportingTransactionalAdapter',
      );
    });
  });

  describe('getTransactionContextRegistryToken', () => {
    it('returns the singleton token regardless of how many times called', () => {
      expect(getTransactionContextRegistryToken()).toBe('TransactionContextRegistry');
      expect(getTransactionContextRegistryToken()).toBe('TransactionContextRegistry');
    });
  });

  describe('cross-token uniqueness', () => {
    it('produces distinct strings per component for the same dataSource', () => {
      const ds = 'billing';
      const tokens = new Set([
        getTransactionManagerToken(ds),
        getTransactionContextToken(ds),
        getTransactionalAdapterToken(ds),
      ]);
      expect(tokens.size).toBe(3);
    });

    it('produces distinct strings per dataSource for the same component', () => {
      const tokens = new Set([
        getTransactionManagerToken('billing'),
        getTransactionManagerToken('inventory'),
        getTransactionManagerToken('audit'),
      ]);
      expect(tokens.size).toBe(3);
    });
  });
});
