import { Injectable, Logger } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionManager } from '@nestjs-transactional/core';

import { TransactionalEventsHandler } from '../decorators/transactional-events-handler.decorator';
import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';
import { TransactionPhase } from '../types/transactional-listener.types';

import { TransactionalListenerScanner } from './listener-scanner';

class OrderPlaced {
  constructor(readonly orderId = 'order-1') {}
}

class PaymentCaptured {
  constructor(readonly paymentId = 'pay-1') {}
}

class UnrelatedEvent {}

@Injectable()
@TransactionalEventsHandler(OrderPlaced)
class OrderPlacedHandler {
  handle(_event: OrderPlaced): void {}
}

@Injectable()
@TransactionalEventsHandler({
  events: [PaymentCaptured],
  phase: TransactionPhase.BEFORE_COMMIT,
})
class PaymentCapturedHandler {
  handle(_event: PaymentCaptured): void {}
}

@Injectable()
@TransactionalEventsHandler({
  events: [OrderPlaced],
  phase: TransactionPhase.AFTER_ROLLBACK,
  fallbackExecution: true,
})
class OrderPlacedRollbackHandler {
  handle(_event: OrderPlaced, _error?: unknown): void {}
}

@Injectable()
@TransactionalEventsHandler(OrderPlaced, PaymentCaptured)
class MultiEventHandler {
  handle(_event: OrderPlaced | PaymentCaptured): void {}
}

@Injectable()
class UndecoratedService {
  doWork(): void {}
}

// Minimal stub — the scanner only needs the dispatcher to have a
// working `registerListener`; no real TransactionManager interaction
// is required for these tests.
const fakeManagerProvider = {
  provide: TransactionManager,
  useValue: {
    registerBeforeCommit: jest.fn(),
    registerAfterCommit: jest.fn(),
    registerAfterRollback: jest.fn(),
  },
};

describe('TransactionalListenerScanner', () => {
  let module: TestingModule;
  let dispatcher: TransactionalEventDispatcher;
  let registerSpy: jest.SpyInstance;

  const buildModule = async (extraProviders: unknown[]): Promise<void> => {
    module = await Test.createTestingModule({
      imports: [DiscoveryModule],
      providers: [
        fakeManagerProvider,
        TransactionalEventDispatcher,
        TransactionalListenerScanner,
        ...(extraProviders as never[]),
      ],
    }).compile();

    dispatcher = module.get(TransactionalEventDispatcher);
    registerSpy = jest.spyOn(dispatcher, 'registerListener');

    await module.init();
  };

  afterEach(async () => {
    if (module !== undefined) {
      await module.close();
    }
  });

  it('registers a decorated handler class after app init', async () => {
    await buildModule([OrderPlacedHandler]);

    const handler = module.get(OrderPlacedHandler);

    expect(registerSpy).toHaveBeenCalled();
    const call = registerSpy.mock.calls.find(([inst]) => inst === handler);
    expect(call).toBeDefined();
    expect(call?.[1]).toBe('handle');
    expect(call?.[2]).toMatchObject({
      eventType: OrderPlaced,
      phase: TransactionPhase.AFTER_COMMIT,
      async: false,
      fallbackExecution: false,
    });
  });

  it('propagates non-default options (BEFORE_COMMIT)', async () => {
    await buildModule([PaymentCapturedHandler]);

    const handler = module.get(PaymentCapturedHandler);
    const call = registerSpy.mock.calls.find(([inst]) => inst === handler);

    expect(call?.[2]).toMatchObject({
      eventType: PaymentCaptured,
      phase: TransactionPhase.BEFORE_COMMIT,
    });
  });

  it('propagates fallbackExecution and AFTER_ROLLBACK phase', async () => {
    await buildModule([OrderPlacedRollbackHandler]);

    const handler = module.get(OrderPlacedRollbackHandler);
    const call = registerSpy.mock.calls.find(([inst]) => inst === handler);

    expect(call?.[2]).toMatchObject({
      eventType: OrderPlaced,
      phase: TransactionPhase.AFTER_ROLLBACK,
      fallbackExecution: true,
    });
  });

  it('registers one entry per event type for multi-event handlers', async () => {
    await buildModule([MultiEventHandler]);

    const handler = module.get(MultiEventHandler);
    const calls = registerSpy.mock.calls.filter(([inst]) => inst === handler);

    expect(calls).toHaveLength(2);
    const eventTypes = calls.map(([, , metadata]) => (metadata as { eventType: unknown }).eventType);
    expect(eventTypes).toContain(OrderPlaced);
    expect(eventTypes).toContain(PaymentCaptured);
  });

  it('does not register providers without the decorator', async () => {
    await buildModule([OrderPlacedHandler, UndecoratedService]);

    const undecorated = module.get(UndecoratedService);
    const call = registerSpy.mock.calls.find(([inst]) => inst === undecorated);
    expect(call).toBeUndefined();
  });

  it('warns and skips a decorated class that does not expose `handle`', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    @Injectable()
    @TransactionalEventsHandler(UnrelatedEvent)
    class BrokenHandler {
      // intentionally no `handle` method
      doSomething(): void {}
    }

    await buildModule([BrokenHandler]);

    const broken = module.get(BrokenHandler);
    const call = registerSpy.mock.calls.find(([inst]) => inst === broken);
    expect(call).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('BrokenHandler'),
    );
  });

  it('picks up multiple decorated handlers across providers', async () => {
    await buildModule([OrderPlacedHandler, OrderPlacedRollbackHandler]);

    const h1 = module.get(OrderPlacedHandler);
    const h2 = module.get(OrderPlacedRollbackHandler);

    expect(registerSpy.mock.calls.find(([inst]) => inst === h1)).toBeDefined();
    expect(registerSpy.mock.calls.find(([inst]) => inst === h2)).toBeDefined();
  });
});
