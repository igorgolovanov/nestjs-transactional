import { PropagationMode } from '../types/propagation';

import {
  ReadOnly,
  Transactional,
  TransactionalOn,
  getTransactionalMetadata,
} from './transactional.decorator';

describe('@Transactional', () => {
  describe('as method decorator', () => {
    it('writes metadata with default propagation REQUIRED when no options are given', () => {
      class Service {
        @Transactional()
        async doWork(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.doWork);
      expect(metadata).toBeDefined();
      expect(metadata?.propagation).toBe(PropagationMode.REQUIRED);
    });

    it('preserves explicit options (propagation, isolation, timeout)', () => {
      class Service {
        @Transactional({
          propagation: PropagationMode.REQUIRES_NEW,
          isolation: 'SERIALIZABLE',
          timeout: 5000,
        })
        async doWork(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.doWork);
      expect(metadata?.propagation).toBe(PropagationMode.REQUIRES_NEW);
      expect(metadata?.isolation).toBe('SERIALIZABLE');
      expect(metadata?.timeout).toBe(5000);
    });

    it('decorates only the annotated method — siblings remain without metadata', () => {
      class Service {
        @Transactional()
        async decorated(): Promise<void> {}
        async undecorated(): Promise<void> {}
      }

      expect(getTransactionalMetadata(Service.prototype.decorated)).toBeDefined();
      expect(getTransactionalMetadata(Service.prototype.undecorated)).toBeUndefined();
    });
  });

  describe('as class decorator', () => {
    it('writes metadata on the class constructor', () => {
      @Transactional({ propagation: PropagationMode.REQUIRES_NEW })
      class Service {
        async doWork(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service);
      expect(metadata).toBeDefined();
      expect(metadata?.propagation).toBe(PropagationMode.REQUIRES_NEW);
    });

    it('falls back to default propagation REQUIRED when no options are given', () => {
      @Transactional()
      class Service {}

      const metadata = getTransactionalMetadata(Service);
      expect(metadata?.propagation).toBe(PropagationMode.REQUIRED);
    });

    it('does not write method metadata onto sibling methods of the class', () => {
      @Transactional({ propagation: PropagationMode.MANDATORY })
      class Service {
        async doWork(): Promise<void> {}
      }

      // Class-level metadata is on the constructor, not on the method function.
      expect(getTransactionalMetadata(Service)).toBeDefined();
      expect(getTransactionalMetadata(Service.prototype.doWork)).toBeUndefined();
    });
  });

  describe('@ReadOnly', () => {
    it('sets readOnly: true with default propagation', () => {
      class Service {
        @ReadOnly()
        async loadUser(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.loadUser);
      expect(metadata?.readOnly).toBe(true);
      expect(metadata?.propagation).toBe(PropagationMode.REQUIRED);
    });

    it('keeps readOnly: true even when options explicitly pass readOnly: false', () => {
      class Service {
        @ReadOnly({ readOnly: false })
        async loadUser(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.loadUser);
      expect(metadata?.readOnly).toBe(true);
    });

    it('passes through other options', () => {
      class Service {
        @ReadOnly({ timeout: 1000, isolation: 'REPEATABLE_READ' })
        async loadUser(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.loadUser);
      expect(metadata?.readOnly).toBe(true);
      expect(metadata?.timeout).toBe(1000);
      expect(metadata?.isolation).toBe('REPEATABLE_READ');
    });
  });

  describe('@TransactionalOn', () => {
    it('sets the adapterInstance', () => {
      class Service {
        @TransactionalOn('billing')
        async charge(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.charge);
      expect(metadata?.adapterInstance).toBe('billing');
    });

    it('overrides adapterInstance from passed options (argument wins)', () => {
      class Service {
        @TransactionalOn('billing', { adapterInstance: 'ignored' })
        async charge(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.charge);
      expect(metadata?.adapterInstance).toBe('billing');
    });

    it('passes through other options', () => {
      class Service {
        @TransactionalOn('billing', {
          propagation: PropagationMode.REQUIRES_NEW,
          readOnly: false,
        })
        async charge(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.charge);
      expect(metadata?.adapterInstance).toBe('billing');
      expect(metadata?.propagation).toBe(PropagationMode.REQUIRES_NEW);
      expect(metadata?.readOnly).toBe(false);
    });
  });

  describe('getTransactionalMetadata', () => {
    it('returns undefined for a method without @Transactional', () => {
      class Service {
        async plain(): Promise<void> {}
      }

      expect(getTransactionalMetadata(Service.prototype.plain)).toBeUndefined();
    });

    it('returns undefined for a class without @Transactional', () => {
      class Plain {}

      expect(getTransactionalMetadata(Plain)).toBeUndefined();
    });

    it('reads the same metadata object that was written (referential equality of fields)', () => {
      const rollbackClasses = [Error];

      class Service {
        @Transactional({ rollbackFor: rollbackClasses })
        async work(): Promise<void> {}
      }

      const metadata = getTransactionalMetadata(Service.prototype.work);
      expect(metadata?.rollbackFor).toBe(rollbackClasses);
    });
  });
});
