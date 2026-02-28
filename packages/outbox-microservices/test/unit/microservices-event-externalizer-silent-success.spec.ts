/**
 * Documents — and pins — the reliability contract that
 * `MicroservicesEventExternalizer` actually inherits from
 * `@nestjs/microservices` `ClientProxy`. See
 * [docs/adr/016-externalization-reliability-semantics.md](../../../../docs/adr/016-externalization-reliability-semantics.md)
 * for the full discussion.
 *
 * **The contract**: `ClientProxy.emit()` returns an Observable that
 * completes when the proxy considers the dispatch handed off — for
 * Kafka, RabbitMQ, NATS, gRPC, ... this means *queued for transport*,
 * not necessarily *acknowledged by the broker*. With the producer in
 * a fire-and-forget configuration (the default) `emit()` can complete
 * without the message ever reaching a broker (broker unreachable,
 * cluster failover, configuration mistakes, ...).
 *
 * The externalizer faithfully wraps that Observable: it considers
 * the publication "delivered" the moment the Observable completes.
 * It can NOT detect a silent broker-side failure — there is no
 * signal at this layer to detect it from. Phase 11.4 integration
 * testing surfaced this finding while attempting a "broker
 * unreachable → publication FAILED" assertion against testcontainers
 * Kafka; the publication transitioned to `COMPLETED` despite no
 * message landing on the topic.
 *
 * Tests below intentionally assert the silent-success behavior so
 * that any future change to that contract — for example a
 * broker-aware externalizer that issues a real round-trip — surfaces
 * here as an explicit behavioral diff.
 */
import { type InjectionToken, Logger } from '@nestjs/common';
import { type ModuleRef } from '@nestjs/core';
import { type ClientProxy } from '@nestjs/microservices';
import { type ExternalizationMetadata } from '@nestjs-transactional/outbox-core';
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

describe('MicroservicesEventExternalizer — silent-success contract (ADR-016)', () => {
  let emit: jest.Mock<Observable<unknown>>;
  let resolveClient: ResolveClientMock;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    emit = jest.fn();
    const proxy = { emit } as unknown as ClientProxy;
    resolveClient = jest
      .fn<ClientProxy | null, ResolveClientArgs>()
      .mockReturnValue(proxy);
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

  it('models the silent-failure scenario: emit() completes without error even when the broker would not have received the message', async () => {
    // What an unreachable-broker `ClientProxy.emit()` looks like to
    // the externalizer in fire-and-forget mode: a completed Observable
    // with no error signal. The externalizer faithfully reports
    // success — pinning this behavior is the whole point of this
    // file. ADR-016 lists the production mitigation strategies.
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
