import { type InjectionToken, Logger } from '@nestjs/common';
import { type ModuleRef } from '@nestjs/core';
import { type ClientProxy } from '@nestjs/microservices';
import {
  ExternalizationError,
  type ExternalizationMetadata,
} from '@nestjs-transactional/outbox';
import { Observable, of, throwError } from 'rxjs';

import { MicroservicesEventExternalizer } from '../../src/externalizer/microservices-event-externalizer';
import { type OutboxMicroservicesOptions } from '../../src/types/options';

const DEFAULT_TOKEN = 'KAFKA_CLIENT';
const OVERRIDE_TOKEN = 'AMQP_CLIENT';
const SYMBOL_TOKEN = Symbol.for('SYMBOL_CLIENT');

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

type ResolveClientArgs = [InjectionToken, { strict: boolean }];
type ResolveClientMock = jest.Mock<ClientProxy | null, ResolveClientArgs>;

function buildExternalizer(
  options: OutboxMicroservicesOptions,
  resolveClient: ResolveClientMock,
): MicroservicesEventExternalizer {
  const moduleRef = { get: resolveClient } as unknown as ModuleRef;
  return new MicroservicesEventExternalizer(moduleRef, options);
}

function metadataFor(
  eventType: string,
  overrides: Partial<ExternalizationMetadata> = {},
): ExternalizationMetadata {
  return {
    eventType,
    target: 'orders.placed',
    ...overrides,
  };
}

/**
 * Run a thrower and return the captured ExternalizationError.
 * Fails the test if no error was thrown — turns the typing surface
 * for `expect(err.cause)` etc. into a concrete `ExternalizationError`
 * instead of `void | ExternalizationError`.
 */
async function captureError(action: () => Promise<unknown>): Promise<ExternalizationError> {
  try {
    await action();
  } catch (err) {
    if (err instanceof ExternalizationError) {
      return err;
    }
    throw err;
  }
  throw new Error('Expected ExternalizationError to be thrown');
}

describe('MicroservicesEventExternalizer', () => {
  let emit: jest.Mock;
  let client: ClientProxy;
  let resolveClient: ResolveClientMock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    emit = jest.fn().mockReturnValue(of(undefined));
    client = { emit } as unknown as ClientProxy;
    resolveClient = jest
      .fn<ClientProxy | null, ResolveClientArgs>()
      .mockReturnValue(client);
  });

  describe('externalize()', () => {
    it('uses the defaultClient from options when @Externalized provides no override', async () => {
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);
      const event = new OrderPlacedEvent('order-1');

      await externalizer.externalize(event, metadataFor('OrderPlacedEvent'));

      expect(resolveClient).toHaveBeenCalledWith(DEFAULT_TOKEN, { strict: false });
      expect(emit).toHaveBeenCalledWith('orders.placed', event);
    });

    it('per-event client override (metadata.client) takes precedence over defaultClient', async () => {
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);
      const event = new OrderPlacedEvent('order-2');

      await externalizer.externalize(
        event,
        metadataFor('OrderPlacedEvent', { client: OVERRIDE_TOKEN }),
      );

      expect(resolveClient).toHaveBeenCalledWith(OVERRIDE_TOKEN, { strict: false });
      expect(emit).toHaveBeenCalledWith('orders.placed', event);
    });

    it('symbol client tokens are forwarded unchanged to ModuleRef.get', async () => {
      const externalizer = buildExternalizer({ defaultClient: SYMBOL_TOKEN }, resolveClient);

      await externalizer.externalize(new OrderPlacedEvent('order-3'), metadataFor('OrderPlacedEvent'));

      expect(resolveClient).toHaveBeenCalledWith(SYMBOL_TOKEN, { strict: false });
    });

    it('throws ExternalizationError when neither defaultClient nor metadata.client is set', async () => {
      const externalizer = buildExternalizer({}, resolveClient);

      await expect(
        externalizer.externalize(new OrderPlacedEvent('o-1'), metadataFor('OrderPlacedEvent')),
      ).rejects.toBeInstanceOf(ExternalizationError);
      await expect(
        externalizer.externalize(new OrderPlacedEvent('o-1'), metadataFor('OrderPlacedEvent')),
      ).rejects.toMatchObject({
        eventType: 'OrderPlacedEvent',
        target: 'orders.placed',
      });
      expect(resolveClient).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('wraps ModuleRef.get failures in ExternalizationError with cause + diagnostic context', async () => {
      const lookupErr = new Error('not bound');
      resolveClient.mockImplementation(() => {
        throw lookupErr;
      });
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);

      const err = await captureError(() =>
        externalizer.externalize(new OrderPlacedEvent('o-1'), metadataFor('OrderPlacedEvent')),
      );

      expect(err).toBeInstanceOf(ExternalizationError);
      expect(err.message).toMatch(/KAFKA_CLIENT/);
      expect(err.message).toMatch(/not found in the DI container/);
      expect(err.message).toMatch(/not bound/);
      expect(err.eventType).toBe('OrderPlacedEvent');
      expect(err.target).toBe('orders.placed');
      expect(err.cause).toBe(lookupErr);
    });

    it('treats a null resolution as a missing binding (defensive)', async () => {
      resolveClient.mockReturnValue(null);
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);

      await expect(
        externalizer.externalize(new OrderPlacedEvent('o-1'), metadataFor('OrderPlacedEvent')),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/KAFKA_CLIENT/) as unknown,
        eventType: 'OrderPlacedEvent',
      });
    });

    it('wraps emit() errors in ExternalizationError with the underlying message + cause', async () => {
      const emitErr = new Error('broker unreachable');
      emit.mockReturnValue(throwError(() => emitErr));
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);

      const err = await captureError(() =>
        externalizer.externalize(new OrderPlacedEvent('o-1'), metadataFor('OrderPlacedEvent')),
      );

      expect(err).toBeInstanceOf(ExternalizationError);
      expect(err.message).toMatch(/Failed to publish OrderPlacedEvent/);
      expect(err.message).toMatch(/broker unreachable/);
      expect(err.eventType).toBe('OrderPlacedEvent');
      expect(err.target).toBe('orders.placed');
      expect(err.cause).toBe(emitErr);
    });

    it('awaits the emit Observable so a delayed completion is captured (firstValueFrom semantics)', async () => {
      let resolveLater: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => {
        resolveLater = resolve;
      });
      emit.mockImplementation(
        () =>
          new Observable<undefined>((subscriber) => {
            void completion.then(() => {
              subscriber.next(undefined);
              subscriber.complete();
            });
          }),
      );
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);

      let resolved = false;
      const promise = externalizer
        .externalize(new OrderPlacedEvent('o-1'), metadataFor('OrderPlacedEvent'))
        .then(() => {
          resolved = true;
        });

      await new Promise((r) => setImmediate(r));
      expect(resolved).toBe(false);

      resolveLater();
      await promise;
      expect(resolved).toBe(true);
    });

    it('logs but does not apply headers/routingKey to the wire payload (Phase 11.3 limitation)', async () => {
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);
      const event = new OrderPlacedEvent('o-headers');

      await externalizer.externalize(
        event,
        metadataFor('OrderPlacedEvent', {
          headers: { 'x-tenant': 'A' },
          routingKey: 'A',
        }),
      );

      // Wire payload is the raw event — no envelope, no extra args.
      expect(emit).toHaveBeenCalledWith('orders.placed', event);
      // The limitation surfaces in a debug log message.
      expect(debug).toHaveBeenCalledWith(
        expect.stringMatching(/headers\/routingKey are not applied/) as unknown,
      );
    });
  });

  describe('onApplicationBootstrap()', () => {
    it('resolves the defaultClient and logs success when validation is on (default)', () => {
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);

      expect(() => externalizer.onApplicationBootstrap()).not.toThrow();
      expect(resolveClient).toHaveBeenCalledWith(DEFAULT_TOKEN, { strict: false });
    });

    it('rethrows a descriptive Error when defaultClient is unresolvable', () => {
      resolveClient.mockImplementation(() => {
        throw new Error('Nest could not find provider');
      });
      const externalizer = buildExternalizer({ defaultClient: DEFAULT_TOKEN }, resolveClient);

      expect(() => externalizer.onApplicationBootstrap()).toThrow(
        /defaultClient 'KAFKA_CLIENT' is not registered/,
      );
    });

    it('skips resolution when validateOnBootstrap is explicitly false', () => {
      const externalizer = buildExternalizer(
        { defaultClient: DEFAULT_TOKEN, validateOnBootstrap: false },
        resolveClient,
      );

      externalizer.onApplicationBootstrap();

      expect(resolveClient).not.toHaveBeenCalled();
    });

    it('does not throw when no defaultClient is configured (per-event clients required)', () => {
      const externalizer = buildExternalizer({}, resolveClient);

      expect(() => externalizer.onApplicationBootstrap()).not.toThrow();
      expect(resolveClient).not.toHaveBeenCalled();
    });
  });
});
