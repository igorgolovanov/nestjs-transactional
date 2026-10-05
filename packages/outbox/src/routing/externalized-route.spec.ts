import type { OutboxEnvelope, OutboxMessage } from '@nestjs/outbox';

import { Externalized } from '../externalization/externalized.decorator.js';

import { externalizedRoute, toKafkaPacket } from './externalized-route.js';

@Externalized({ target: 'route.spec.kafka', client: 'KAFKA' })
class ToKafka {}

@Externalized({ target: 'route.spec.default' })
class ToDefault {}

void ToKafka;
void ToDefault;

const message = (topic: string): OutboxMessage => ({
  id: 'm-1',
  topic,
  payload: {},
  headers: {},
  key: null,
  createdAt: 0,
  availableAt: 0,
  attempts: 0,
  lastError: null,
});

describe('externalizedRoute', () => {
  it('routes an externalized target to its client', () => {
    expect(externalizedRoute()(message('route.spec.kafka'))).toBe('KAFKA');
  });

  it('routes a target without a client to defaultTransport', () => {
    expect(externalizedRoute({ defaultTransport: 'RMQ' })(message('route.spec.default'))).toBe(
      'RMQ',
    );
  });

  it('refuses a target without a client when no defaultTransport is set', () => {
    expect(() => externalizedRoute()(message('route.spec.default'))).toThrow(
      /route\.spec\.default.*defaultTransport/s,
    );
  });

  it("sends any other topic to the fallback, 'local' by default", () => {
    expect(externalizedRoute()(message('StockReserved'))).toBe('local');
    expect(externalizedRoute({ fallback: 'inproc' })(message('StockReserved'))).toBe('inproc');
  });
});

describe('toKafkaPacket', () => {
  const envelope: OutboxEnvelope = {
    id: 'm-1',
    topic: 'orders.placed',
    key: 'o-1',
    headers: { tenant: 't-1' },
    createdAt: 1,
    payload: { orderId: 'o-1' },
  };

  it('puts key and headers on the Kafka record and the envelope in its value', () => {
    expect(toKafkaPacket(message('orders.placed'), envelope)).toEqual({
      pattern: 'orders.placed',
      data: { key: 'o-1', value: envelope, headers: { tenant: 't-1', 'x-outbox-id': 'm-1' } },
    });
  });

  it('leaves the key out when the message has none', () => {
    const packet = toKafkaPacket(message('orders.placed'), { ...envelope, key: null });
    expect(packet.data).not.toHaveProperty('key');
  });
});
