/**
 * Pins the one thing this externalizer decides on its own: a
 * `ClientProxy.emit()` Observable that completes is a successful
 * externalization, whatever it did or did not emit on the way. That is
 * what the processor turns into a `COMPLETED` publication, so it is
 * worth an explicit test rather than being implied by the happy path.
 *
 * What a completion *proves* is the transport's business, not ours,
 * and it is not uniform: Kafka settles `producer.send()` with
 * `acks: -1`, RabbitMQ waits for a publisher confirm, NATS core
 * resolves unconditionally because `publish()` returns `void`. The
 * per-transport table and the live measurements are in
 * [docs/adr/021-externalization-acknowledgement-per-transport.md](../../../../docs/adr/021-externalization-acknowledgement-per-transport.md),
 * and the brokers that do acknowledge are covered by
 * `test/integration/reliability.integration.spec.ts` against real
 * containers.
 *
 * This file used to argue the opposite: that `emit()` can never report
 * a broker failure, and that these mocks therefore documented a
 * silent-success limitation. See ADR-016, superseded, for how that
 * conclusion was reached and why it was wrong.
 */
import { type InjectionToken, Logger } from '@nestjs/common';
import { type ModuleRef } from '@nestjs/core';
import { type ClientProxy } from '@nestjs/microservices';
import { type ExternalizationMetadata } from '@nestjs-transactional/outbox';
import { Observable, of } from 'rxjs';

import { MicroservicesEventExternalizer } from '../../src/externalizer/microservices-event-externalizer';
import { type OutboxMicroservicesOptions } from '../../src/types/options';

const KAFKA_TOKEN = 'KAFKA_CLIENT';

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

function metadataFor(eventType: string): ExternalizationMetadata {
  return { eventType, target: 'orders.placed' };
}

describe('MicroservicesEventExternalizer — completion contract (ADR-021)', () => {
  let emit: jest.Mock<Observable<unknown>>;
  let resolveClient: ResolveClientMock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    emit = jest.fn();
    const proxy = { emit } as unknown as ClientProxy;
    resolveClient = jest.fn<ClientProxy | null, ResolveClientArgs>().mockReturnValue(proxy);
  });

  it('considers a synchronous `of(undefined)` completion a successful externalization', async () => {
    emit.mockReturnValue(of(undefined));
    const externalizer = buildExternalizer({ defaultClient: KAFKA_TOKEN }, resolveClient);

    await expect(
      externalizer.externalize(new OrderPlacedEvent('order-1'), metadataFor('OrderPlacedEvent')),
    ).resolves.toBeUndefined();
  });

  it('considers an Observable that emits a value and completes a successful externalization', async () => {
    emit.mockReturnValue(of({ topicPartition: 'orders.placed-0', offset: '0' }));
    const externalizer = buildExternalizer({ defaultClient: KAFKA_TOKEN }, resolveClient);

    await expect(
      externalizer.externalize(new OrderPlacedEvent('order-2'), metadataFor('OrderPlacedEvent')),
    ).resolves.toBeUndefined();
  });

  it('considers an Observable that completes asynchronously without a value a successful externalization', async () => {
    emit.mockReturnValue(
      new Observable<undefined>((subscriber) => {
        setImmediate(() => {
          subscriber.next(undefined);
          subscriber.complete();
        });
      }),
    );
    const externalizer = buildExternalizer({ defaultClient: KAFKA_TOKEN }, resolveClient);

    await expect(
      externalizer.externalize(new OrderPlacedEvent('order-3'), metadataFor('OrderPlacedEvent')),
    ).resolves.toBeUndefined();
  });

  it('does not second-guess a completion: it reports success and subscribes exactly once', async () => {
    // On a transport that acknowledges nothing (NATS core, TCP) this
    // completion is all the externalizer will ever see, and it has no
    // basis to treat it as anything but success. The assertion on the
    // call count matters too: `emit()` returns a cold-ish Observable
    // and a second subscription would publish the event twice.
    emit.mockReturnValue(of(undefined));
    const externalizer = buildExternalizer({ defaultClient: KAFKA_TOKEN }, resolveClient);

    await expect(
      externalizer.externalize(
        new OrderPlacedEvent('order-silent-fail'),
        metadataFor('OrderPlacedEvent'),
      ),
    ).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
