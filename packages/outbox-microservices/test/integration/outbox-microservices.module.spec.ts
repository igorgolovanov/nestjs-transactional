import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { type ClientProxy } from '@nestjs/microservices';
import {
  EVENT_EXTERNALIZER,
  type EventExternalizer,
  type ExternalizationMetadata,
} from '@nestjs-transactional/outbox-core';
import { of } from 'rxjs';

import { MicroservicesEventExternalizer } from '../../src/externalizer/microservices-event-externalizer';
import { OutboxMicroservicesModule } from '../../src/module/outbox-microservices.module';

const KAFKA_TOKEN = 'KAFKA_CLIENT';

class OrderPlacedEvent {
  constructor(readonly orderId: string) {}
}

function makeClientProxyMock(): { proxy: ClientProxy; emit: jest.Mock } {
  const emit = jest.fn().mockReturnValue(of(undefined));
  const proxy = { emit } as unknown as ClientProxy;
  return { proxy, emit };
}

describe('OutboxMicroservicesModule (integration with mock ClientProxy)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('compiles: every provider — externalizer, options, EVENT_EXTERNALIZER — resolves through DI', async () => {
    const { proxy } = makeClientProxyMock();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [OutboxMicroservicesModule.forRoot({ defaultClient: KAFKA_TOKEN })],
      providers: [{ provide: KAFKA_TOKEN, useValue: proxy }],
    }).compile();

    await moduleRef.init();

    expect(moduleRef.get(MicroservicesEventExternalizer)).toBeInstanceOf(
      MicroservicesEventExternalizer,
    );
    expect(moduleRef.get<EventExternalizer>(EVENT_EXTERNALIZER)).toBeInstanceOf(
      MicroservicesEventExternalizer,
    );

    await moduleRef.close();
  });

  it('binds EVENT_EXTERNALIZER and the concrete class to the same instance (useExisting)', async () => {
    const { proxy } = makeClientProxyMock();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [OutboxMicroservicesModule.forRoot({ defaultClient: KAFKA_TOKEN })],
      providers: [{ provide: KAFKA_TOKEN, useValue: proxy }],
    }).compile();
    await moduleRef.init();

    const viaToken = moduleRef.get<EventExternalizer>(EVENT_EXTERNALIZER);
    const viaClass = moduleRef.get(MicroservicesEventExternalizer);

    expect(viaToken).toBe(viaClass);

    await moduleRef.close();
  });

  it('bootstrap validation succeeds when defaultClient is registered', async () => {
    const { proxy } = makeClientProxyMock();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [OutboxMicroservicesModule.forRoot({ defaultClient: KAFKA_TOKEN })],
      providers: [{ provide: KAFKA_TOKEN, useValue: proxy }],
    }).compile();

    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('bootstrap validation fails with a clear error when defaultClient is missing', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [OutboxMicroservicesModule.forRoot({ defaultClient: 'MISSING_CLIENT' })],
    }).compile();

    await expect(moduleRef.init()).rejects.toThrow(
      /defaultClient 'MISSING_CLIENT' is not registered/,
    );
  });

  it('validateOnBootstrap: false defers resolution and tolerates a missing defaultClient at init', async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        OutboxMicroservicesModule.forRoot({
          defaultClient: 'LATE_CLIENT',
          validateOnBootstrap: false,
        }),
      ],
    }).compile();

    await expect(moduleRef.init()).resolves.toBeDefined();
    await moduleRef.close();
  });

  it('externalize() routes through the resolved ClientProxy.emit with target + raw event', async () => {
    const { proxy, emit } = makeClientProxyMock();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [OutboxMicroservicesModule.forRoot({ defaultClient: KAFKA_TOKEN })],
      providers: [{ provide: KAFKA_TOKEN, useValue: proxy }],
    }).compile();
    await moduleRef.init();

    const externalizer = moduleRef.get<EventExternalizer>(EVENT_EXTERNALIZER);
    const event = new OrderPlacedEvent('order-9');
    const metadata: ExternalizationMetadata = {
      eventType: 'OrderPlacedEvent',
      target: 'orders.placed',
    };

    await externalizer.externalize(event, metadata);

    expect(emit).toHaveBeenCalledWith('orders.placed', event);

    await moduleRef.close();
  });

  it('forRootAsync resolves OutboxMicroservicesOptions through a factory', async () => {
    const { proxy } = makeClientProxyMock();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        OutboxMicroservicesModule.forRootAsync({
          useFactory: () => ({ defaultClient: KAFKA_TOKEN }),
        }),
      ],
      providers: [{ provide: KAFKA_TOKEN, useValue: proxy }],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get<EventExternalizer>(EVENT_EXTERNALIZER)).toBeInstanceOf(
      MicroservicesEventExternalizer,
    );
    await moduleRef.close();
  });
});
