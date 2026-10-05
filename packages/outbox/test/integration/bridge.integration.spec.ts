import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { type OutboxEnvelope, OutboxRelay } from '@nestjs/outbox';
import type { TestingModule } from '@nestjs/testing';
import { of } from 'rxjs';

import { OutboxEventPublisher } from '../../src/index.js';
import {
  buildApp,
  Caller,
  OrderPlaced,
  OrderRow,
  OrderService,
  pendingMessages,
  type PostgresContext,
  startPostgres,
  stopPostgres,
} from '../support/app.js';

/**
 * The bridge against real PostgreSQL (DD-028): a message added through
 * `OutboxEventPublisher` shares the fate of the business rows under
 * every propagation that matters, and reaches the routed `ClientProxy`
 * as an envelope. Runs in the TypeORM version matrix, because what it
 * really exercises is `@nestjs/outbox`'s TypeORM executor accepting the
 * transaction `@Transactional` opened.
 */
describe('outbox bridge on PostgreSQL (testcontainers)', () => {
  let pg: PostgresContext;
  let app: TestingModule;
  const emitted: { pattern: unknown; data: unknown }[] = [];

  const messages = async (): Promise<{ topic: string; key: string | null }[]> =>
    (await pendingMessages(pg.dataSource)).map(({ topic, key }) => ({ topic, key }));
  const orders = async (): Promise<string[]> =>
    (await pg.dataSource.getRepository(OrderRow).find({ order: { id: 'ASC' } })).map((o) => o.id);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    pg = await startPostgres();
    app = await buildApp(pg.dataSource, {
      emit: (pattern: unknown, data: unknown) => {
        emitted.push({ pattern, data });
        return of(undefined);
      },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await stopPostgres(pg);
  });

  beforeEach(async () => {
    await pg.dataSource.query('TRUNCATE nest_outbox.messages, bridge_orders');
    emitted.length = 0;
  });

  it('commits the message with the business row', async () => {
    await app.get(OrderService).place('o-1');

    expect(await orders()).toEqual(['o-1']);
    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'o-1' }]);
  });

  it('rolls the message back with the business row', async () => {
    await expect(app.get(OrderService).placeThenFail('o-2')).rejects.toThrow('forced rollback');

    expect(await orders()).toEqual([]);
    expect(await messages()).toEqual([]);
  });

  it('keeps a REQUIRES_NEW message when the outer transaction rolls back', async () => {
    await expect(app.get(Caller).outerFailsAroundRequiresNew('outer', 'inner')).rejects.toThrow(
      'outer rollback',
    );

    expect(await orders()).toEqual(['inner']);
    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'inner' }]);
  });

  it('drops a NESTED message with its savepoint while the outer one commits', async () => {
    await app.get(Caller).outerCommitsAroundFailedNested('outer', 'nested');

    expect(await orders()).toEqual(['outer']);
    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'outer' }]);
  });

  it('works under SERIALIZABLE isolation', async () => {
    await app.get(Caller).placeSerializable('o-ser');

    expect(await messages()).toEqual([{ topic: 'bridge.orders.placed', key: 'o-ser' }]);
  });

  it('writes a non-externalized event under its class name', async () => {
    await app.get(OrderService).placeWithLocalFollowUp('o-3');

    // In the order they were added, which is the order they commit in.
    expect(await messages()).toEqual([
      { topic: 'bridge.orders.placed', key: 'o-3' },
      { topic: 'StockReserved', key: null },
    ]);
  });

  it('refuses to publish outside a transaction', async () => {
    await expect(app.get(OutboxEventPublisher).publish(new OrderPlaced('o-4'))).rejects.toThrow(
      /inside a transaction/,
    );
    expect(await messages()).toEqual([]);
  });

  it('delivers the envelope through the routed ClientProxy transport', async () => {
    await app.get(OrderService).place('o-5');
    await app.get(OutboxRelay).runOnce();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.pattern).toBe('bridge.orders.placed');
    const envelope = emitted[0]!.data as OutboxEnvelope<{ orderId: string }>;
    expect(envelope.payload).toEqual({ orderId: 'o-5' });
    expect(envelope.key).toBe('o-5');
    expect(envelope.headers).toEqual({ source: 'bridge-spec', 'x-event-type': 'OrderPlaced' });
    expect(await messages()).toEqual([]);
  });
});
