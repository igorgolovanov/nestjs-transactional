import {
  TRANSACTIONAL_EVENTS_LISTENER_METADATA,
  TransactionPhase,
} from '../../src/types/transactional-listener.types';
import {
  TransactionalEventsListener,
  getTransactionalEventsListenerMetadata,
} from '../../src/decorators/transactional-events-listener.decorator';

class OrderPlaced {
  constructor(readonly orderId: string) {}
}

class PaymentCaptured {
  constructor(readonly paymentId: string) {}
}

describe('@TransactionalEventsListener', () => {
  describe('metadata attachment', () => {
    it('writes metadata onto the decorated method function', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        onPlaced(_event: OrderPlaced): void {}
      }

      const metadata = getTransactionalEventsListenerMetadata(Listener.prototype.onPlaced);
      expect(metadata).toBeDefined();
      expect(metadata?.eventType).toBe(OrderPlaced);
    });

    it('is readable via the raw reflect-metadata API under the exported symbol', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        onPlaced(): void {}
      }

      const raw: unknown = Reflect.getMetadata(
        TRANSACTIONAL_EVENTS_LISTENER_METADATA,
        Listener.prototype.onPlaced,
      );
      expect(raw).toMatchObject({ eventType: OrderPlaced });
    });

    it('does not contaminate sibling methods on the same class', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        decorated(): void {}
        undecorated(): void {}
      }

      expect(
        getTransactionalEventsListenerMetadata(Listener.prototype.decorated),
      ).toBeDefined();
      expect(
        getTransactionalEventsListenerMetadata(Listener.prototype.undecorated),
      ).toBeUndefined();
    });
  });

  describe('defaults', () => {
    it('defaults phase to AFTER_COMMIT when no options are given', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        onPlaced(): void {}
      }

      const metadata = getTransactionalEventsListenerMetadata(Listener.prototype.onPlaced);
      expect(metadata?.phase).toBe(TransactionPhase.AFTER_COMMIT);
    });

    it('defaults fallbackExecution to false', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        onPlaced(): void {}
      }

      const metadata = getTransactionalEventsListenerMetadata(Listener.prototype.onPlaced);
      expect(metadata?.fallbackExecution).toBe(false);
    });

    it('defaults async to false', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        onPlaced(): void {}
      }

      const metadata = getTransactionalEventsListenerMetadata(Listener.prototype.onPlaced);
      expect(metadata?.async).toBe(false);
    });
  });

  describe('option preservation', () => {
    it('preserves all provided options (phase, fallbackExecution, async)', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced, {
          phase: TransactionPhase.BEFORE_COMMIT,
          fallbackExecution: true,
          async: true,
        })
        onPlaced(): void {}
      }

      const metadata = getTransactionalEventsListenerMetadata(Listener.prototype.onPlaced);
      expect(metadata).toEqual({
        eventType: OrderPlaced,
        phase: TransactionPhase.BEFORE_COMMIT,
        fallbackExecution: true,
        async: true,
      });
    });

    it('accepts each phase value independently', () => {
      const phases = [
        TransactionPhase.BEFORE_COMMIT,
        TransactionPhase.AFTER_COMMIT,
        TransactionPhase.AFTER_ROLLBACK,
        TransactionPhase.AFTER_COMPLETION,
      ];

      for (const phase of phases) {
        class Listener {
          @TransactionalEventsListener(OrderPlaced, { phase })
          onPlaced(): void {}
        }

        const metadata = getTransactionalEventsListenerMetadata(Listener.prototype.onPlaced);
        expect(metadata?.phase).toBe(phase);
      }
    });

    it('allows distinct event types on distinct listener methods', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        onPlaced(): void {}

        @TransactionalEventsListener(PaymentCaptured, { phase: TransactionPhase.BEFORE_COMMIT })
        onPayment(): void {}
      }

      const placed = getTransactionalEventsListenerMetadata(Listener.prototype.onPlaced);
      const payment = getTransactionalEventsListenerMetadata(Listener.prototype.onPayment);

      expect(placed?.eventType).toBe(OrderPlaced);
      expect(placed?.phase).toBe(TransactionPhase.AFTER_COMMIT);
      expect(payment?.eventType).toBe(PaymentCaptured);
      expect(payment?.phase).toBe(TransactionPhase.BEFORE_COMMIT);
    });
  });

  describe('getTransactionalEventsListenerMetadata', () => {
    it('returns undefined for an undecorated method', () => {
      class Listener {
        plain(): void {}
      }

      expect(
        getTransactionalEventsListenerMetadata(Listener.prototype.plain),
      ).toBeUndefined();
    });

    it('returns undefined for a class constructor (decorator only attaches to methods)', () => {
      class Listener {
        @TransactionalEventsListener(OrderPlaced)
        onPlaced(): void {}
      }

      expect(getTransactionalEventsListenerMetadata(Listener)).toBeUndefined();
    });
  });
});
