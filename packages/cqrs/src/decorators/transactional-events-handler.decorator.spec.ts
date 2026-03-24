import type { ITransactionalEventHandler } from '../interfaces/transactional-event-handler.interface';
import { TransactionPhase } from '../types/transactional-listener.types';

import {
  TRANSACTIONAL_EVENTS_HANDLER_METADATA,
  TransactionalEventsHandler,
  getTransactionalEventsHandlerMetadata,
} from './transactional-events-handler.decorator';

class OrderPlaced {
  constructor(readonly orderId: string) {}
}

class PaymentCaptured {
  constructor(readonly paymentId: string) {}
}

describe('@TransactionalEventsHandler', () => {
  describe('rest-params short form', () => {
    it('writes metadata onto the decorated class with a single event type', () => {
      @TransactionalEventsHandler(OrderPlaced)
      class Handler implements ITransactionalEventHandler<OrderPlaced> {
        handle(_event: OrderPlaced): void {}
      }

      const metadata = getTransactionalEventsHandlerMetadata(Handler);
      expect(metadata).toBeDefined();
      expect(metadata?.eventTypes).toEqual([OrderPlaced]);
      expect(metadata?.phase).toBe(TransactionPhase.AFTER_COMMIT);
      expect(metadata?.async).toBe(false);
      expect(metadata?.fallbackExecution).toBe(false);
    });

    it('accepts multiple event types', () => {
      @TransactionalEventsHandler(OrderPlaced, PaymentCaptured)
      class Handler implements ITransactionalEventHandler<OrderPlaced | PaymentCaptured> {
        handle(_event: OrderPlaced | PaymentCaptured): void {}
      }

      const metadata = getTransactionalEventsHandlerMetadata(Handler);
      expect(metadata?.eventTypes).toEqual([OrderPlaced, PaymentCaptured]);
    });

    it('is readable via the exported metadata key', () => {
      @TransactionalEventsHandler(OrderPlaced)
      class Handler implements ITransactionalEventHandler<OrderPlaced> {
        handle(_event: OrderPlaced): void {}
      }

      const raw: unknown = Reflect.getMetadata(TRANSACTIONAL_EVENTS_HANDLER_METADATA, Handler);
      expect(raw).toMatchObject({ eventTypes: [OrderPlaced] });
    });
  });

  describe('options long form', () => {
    it('accepts { events } with defaults', () => {
      @TransactionalEventsHandler({ events: [OrderPlaced] })
      class Handler implements ITransactionalEventHandler<OrderPlaced> {
        handle(_event: OrderPlaced): void {}
      }

      const metadata = getTransactionalEventsHandlerMetadata(Handler);
      expect(metadata).toEqual({
        eventTypes: [OrderPlaced],
        phase: TransactionPhase.AFTER_COMMIT,
        async: false,
        fallbackExecution: false,
        dataSource: 'default',
      });
    });

    it('preserves all provided options', () => {
      @TransactionalEventsHandler({
        events: [OrderPlaced, PaymentCaptured],
        phase: TransactionPhase.BEFORE_COMMIT,
        async: true,
        fallbackExecution: true,
        dataSource: 'billing',
      })
      class Handler implements ITransactionalEventHandler<OrderPlaced | PaymentCaptured> {
        handle(_event: OrderPlaced | PaymentCaptured): void {}
      }

      const metadata = getTransactionalEventsHandlerMetadata(Handler);
      expect(metadata).toEqual({
        eventTypes: [OrderPlaced, PaymentCaptured],
        phase: TransactionPhase.BEFORE_COMMIT,
        async: true,
        fallbackExecution: true,
        dataSource: 'billing',
      });
    });

    it('defaults dataSource to "default" when omitted', () => {
      @TransactionalEventsHandler({ events: [OrderPlaced] })
      class Handler implements ITransactionalEventHandler<OrderPlaced> {
        handle(_event: OrderPlaced): void {}
      }

      expect(getTransactionalEventsHandlerMetadata(Handler)?.dataSource).toBe('default');
    });

    it('accepts each phase independently', () => {
      const phases = [
        TransactionPhase.BEFORE_COMMIT,
        TransactionPhase.AFTER_COMMIT,
        TransactionPhase.AFTER_ROLLBACK,
        TransactionPhase.AFTER_COMPLETION,
      ];

      for (const phase of phases) {
        @TransactionalEventsHandler({ events: [OrderPlaced], phase })
        class Handler implements ITransactionalEventHandler<OrderPlaced> {
          handle(_event: OrderPlaced): void {}
        }

        expect(getTransactionalEventsHandlerMetadata(Handler)?.phase).toBe(phase);
      }
    });
  });

  describe('validation', () => {
    it('throws when called with no event types (rest-params)', () => {
      expect(() => TransactionalEventsHandler()).toThrow(/at least one event type/);
    });

    it('throws when called with an empty events array (options)', () => {
      expect(() => TransactionalEventsHandler({ events: [] })).toThrow(
        /at least one event type/,
      );
    });
  });

  describe('getTransactionalEventsHandlerMetadata', () => {
    it('returns undefined for an undecorated class', () => {
      class PlainClass {}
      expect(getTransactionalEventsHandlerMetadata(PlainClass)).toBeUndefined();
    });

    it('distinct decorations produce distinct metadata (no cross-contamination)', () => {
      @TransactionalEventsHandler(OrderPlaced)
      class HandlerA implements ITransactionalEventHandler<OrderPlaced> {
        handle(_event: OrderPlaced): void {}
      }

      @TransactionalEventsHandler(PaymentCaptured)
      class HandlerB implements ITransactionalEventHandler<PaymentCaptured> {
        handle(_event: PaymentCaptured): void {}
      }

      expect(getTransactionalEventsHandlerMetadata(HandlerA)?.eventTypes).toEqual([OrderPlaced]);
      expect(getTransactionalEventsHandlerMetadata(HandlerB)?.eventTypes).toEqual([
        PaymentCaptured,
      ]);
    });
  });
});
