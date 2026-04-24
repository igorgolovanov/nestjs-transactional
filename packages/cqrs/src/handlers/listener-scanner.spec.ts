import { Injectable } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { TransactionManager } from '@nestjs-transactional/core';

import { TransactionalEventsListener } from '../decorators/transactional-events-listener.decorator';
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
class DecoratedService {
  @TransactionalEventsListener(OrderPlaced)
  onOrderPlaced(_event: OrderPlaced): void {}

  @TransactionalEventsListener(PaymentCaptured, { phase: TransactionPhase.BEFORE_COMMIT })
  onPaymentCaptured(_event: PaymentCaptured): void {}

  plainMethod(): void {}
}

@Injectable()
class UndecoratedService {
  doWork(): void {}
}

@Injectable()
class AnotherDecoratedService {
  @TransactionalEventsListener(OrderPlaced, {
    phase: TransactionPhase.AFTER_ROLLBACK,
    fallbackExecution: true,
  })
  onOrderPlacedRollback(_event: OrderPlaced, _error: unknown): void {}
}

// Minimal stub — the scanner only needs the dispatcher to have a working
// `registerListener`; no real TransactionManager interaction is required.
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

  it('registers a decorated listener method after app init', async () => {
    await buildModule([DecoratedService]);

    const decorated = module.get(DecoratedService);

    expect(registerSpy).toHaveBeenCalled();
    const onOrderPlacedCall = registerSpy.mock.calls.find(
      ([, methodName]) => methodName === 'onOrderPlaced',
    );
    expect(onOrderPlacedCall).toBeDefined();
    expect(onOrderPlacedCall?.[0]).toBe(decorated);
    expect(onOrderPlacedCall?.[2]).toMatchObject({
      eventType: OrderPlaced,
      phase: TransactionPhase.AFTER_COMMIT,
    });
  });

  it('registers every decorated method on a service that has multiple listeners', async () => {
    await buildModule([DecoratedService]);

    const decorated = module.get(DecoratedService);
    const calls = registerSpy.mock.calls.filter(([inst]) => inst === decorated);

    const methodNames = calls.map(([, method]) => method as string).sort();
    expect(methodNames).toEqual(['onOrderPlaced', 'onPaymentCaptured']);

    const paymentCall = calls.find(([, method]) => method === 'onPaymentCaptured');
    expect(paymentCall?.[2]).toMatchObject({
      eventType: PaymentCaptured,
      phase: TransactionPhase.BEFORE_COMMIT,
    });
  });

  it('does not register undecorated methods on a decorated service', async () => {
    await buildModule([DecoratedService]);

    const decorated = module.get(DecoratedService);
    const plainCall = registerSpy.mock.calls.find(
      ([inst, method]) => inst === decorated && method === 'plainMethod',
    );
    expect(plainCall).toBeUndefined();
  });

  it('does not register any method of a service with no decorated methods', async () => {
    await buildModule([DecoratedService, UndecoratedService]);

    const undecorated = module.get(UndecoratedService);
    const call = registerSpy.mock.calls.find(([inst]) => inst === undecorated);
    expect(call).toBeUndefined();
  });

  it('picks up listeners across multiple providers', async () => {
    await buildModule([DecoratedService, AnotherDecoratedService]);

    const decorated = module.get(DecoratedService);
    const another = module.get(AnotherDecoratedService);

    expect(
      registerSpy.mock.calls.find(
        ([inst, method]) => inst === decorated && method === 'onOrderPlaced',
      ),
    ).toBeDefined();

    const anotherCall = registerSpy.mock.calls.find(
      ([inst, method]) => inst === another && method === 'onOrderPlacedRollback',
    );
    expect(anotherCall).toBeDefined();
    expect(anotherCall?.[2]).toMatchObject({
      eventType: OrderPlaced,
      phase: TransactionPhase.AFTER_ROLLBACK,
      fallbackExecution: true,
    });
  });

  it('ignores methods decorated for unrelated events (metadata still attaches but no filtering occurs here)', async () => {
    @Injectable()
    class UnrelatedListener {
      @TransactionalEventsListener(UnrelatedEvent)
      onUnrelated(_event: UnrelatedEvent): void {}
    }

    await buildModule([UnrelatedListener]);

    const instance = module.get(UnrelatedListener);
    const call = registerSpy.mock.calls.find(
      ([inst, method]) => inst === instance && method === 'onUnrelated',
    );
    expect(call).toBeDefined();
    expect(call?.[2]).toMatchObject({ eventType: UnrelatedEvent });
  });
});
