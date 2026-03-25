import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { OrderService } from '../src/order.service';
import { ShippingHandler } from '../src/shipping.handler';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: timed out after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('basic-outbox', () => {
  let module: TestingModule;
  let orders: OrderService;
  let shipping: ShippingHandler;

  beforeEach(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.init();
    orders = module.get(OrderService);
    shipping = module.get(ShippingHandler);
  });

  afterEach(async () => {
    await module.close();
  });

  it('delivers a published event to the @OutboxEventsHandler after the publishing tx commits', async () => {
    await orders.placeOrder('o-1', 'alice@example.com');

    await waitFor(() => shipping.handled.some((e) => e.orderId === 'o-1'));

    expect(shipping.handled).toHaveLength(1);
    const [delivered] = shipping.handled;
    expect(delivered).toBeDefined();
    expect(delivered?.orderId).toBe('o-1');
    expect(delivered?.customerEmail).toBe('alice@example.com');
  });

  it('does NOT deliver an event when the publishing transaction rolls back', async () => {
    await expect(orders.placeOrderAndFail('o-2', 'bob@example.com')).rejects.toThrow(
      'simulated failure after publish — should roll back',
    );

    // Give the worker enough time to deliver if the publication had been
    // persisted — the assertion is that nothing arrives.
    await new Promise((r) => setTimeout(r, 200));

    expect(shipping.handled.find((e) => e.orderId === 'o-2')).toBeUndefined();
  });
});
