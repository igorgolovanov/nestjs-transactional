import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { TestingModule } from '@nestjs/testing';
import { WorkflowClient } from '@nestjs/workflows';

import { WorkflowIsolationError } from '../../src/index.js';
import {
  AwaitDelivery,
  buildApp,
  fulfilmentId,
  OrderRow,
  Orders,
  PlaceOrder,
  type PostgresContext,
  startPostgres,
  stopPostgres,
} from '../support/app.js';

/**
 * The bridge against real PostgreSQL and the real `@nestjs/workflows`
 * (DD-031): a workflow started or signalled inside `@Transactional`,
 * directly or through `WorkflowsCqrsModule`'s `@StartOn`, shares the fate
 * of the business rows, and the worker runs it once they commit.
 */
describe('workflows bridge on PostgreSQL (testcontainers)', () => {
  let pg: PostgresContext;

  const orderIds = async (): Promise<string[]> =>
    (await pg.dataSource.getRepository(OrderRow).find({ order: { id: 'ASC' } })).map((o) => o.id);
  const instance = (app: TestingModule, orderId: string): Promise<unknown> =>
    app.get(WorkflowClient).getStatus(fulfilmentId(orderId));
  const result = (app: TestingModule, id: string): Promise<unknown> =>
    app.get(WorkflowClient).result(id, { timeout: '20s' });

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    pg = await startPostgres();
  });

  afterAll(async () => {
    await stopPostgres(pg);
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await pg.dataSource.query('DELETE FROM wf_orders');
  });

  describe('with TransactionalCqrsModule', () => {
    let app: TestingModule;

    beforeAll(async () => {
      app = await buildApp(pg.dataSource, 'transactional');
    });

    afterAll(async () => {
      await app?.close();
    });

    it('start() without a transaction option commits with the order, and the worker runs it', async () => {
      await app.get(Orders).placeAndStart('o-1');

      expect(await orderIds()).toEqual(['o-1']);
      await expect(result(app, fulfilmentId('o-1'))).resolves.toBe('fulfilled o-1');
    });

    it('start() rolls back with the order', async () => {
      await expect(app.get(Orders).placeAndStart('o-2', true)).rejects.toThrow('forced rollback');

      expect(await orderIds()).toEqual([]);
      expect(await instance(app, 'o-2')).toBeNull();
    });

    it('works under SERIALIZABLE for start()', async () => {
      await app.get(Orders).placeAndStartSerializable('o-3');

      expect(await orderIds()).toEqual(['o-3']);
      await expect(result(app, fulfilmentId('o-3'))).resolves.toBe('fulfilled o-3');
    });

    it('@StartOn on an aggregate event commits with the order', async () => {
      await app.get(CommandBus).execute(new PlaceOrder('o-4'));

      expect(await orderIds()).toEqual(['o-4']);
      await expect(result(app, fulfilmentId('o-4'))).resolves.toBe('fulfilled o-4');
    });

    it('@StartOn on an aggregate event rolls back with the order', async () => {
      await expect(app.get(CommandBus).execute(new PlaceOrder('o-5', true))).rejects.toThrow(
        'forced rollback',
      );

      expect(await orderIds()).toEqual([]);
      expect(await instance(app, 'o-5')).toBeNull();
    });

    it('signal() commits with the business write, and wakes the waiting instance', async () => {
      const { id } = await app.get(WorkflowClient).start(AwaitDelivery, { orderId: 'o-6' });
      await waitUntilSuspended(app, id);

      await expect(app.get(Orders).deliver('o-6', true)).rejects.toThrow('forced rollback');
      expect(await orderIds()).toEqual([]);
      // A rolled-back signal never existed: well past a few worker polls,
      // the instance is still parked on its wait.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await statusOf(app, id)).toBe('suspended');

      await app.get(Orders).deliver('o-6');
      expect(await orderIds()).toEqual(['o-6-delivered']);
      await expect(result(app, id)).resolves.toBe('delivered by ups');
    });

    it('refuses signal() under SERIALIZABLE before writing anything', async () => {
      const before = await pendingSignals(pg);

      await expect(app.get(Orders).deliverSerializable('o-7')).rejects.toThrow(
        WorkflowIsolationError,
      );

      expect(await orderIds()).toEqual([]);
      expect(await pendingSignals(pg)).toBe(before);
    });

    it('lets startAndWait() inside a transaction create and finish the instance', async () => {
      await expect(app.get(Orders).startAndWaitInside('o-8')).resolves.toBe('fulfilled o-8');
    });
  });

  describe('with stock CqrsModule', () => {
    let app: TestingModule;

    beforeAll(async () => {
      app = await buildApp(pg.dataSource, 'stock');
    });

    afterAll(async () => {
      await app?.close();
    });

    // WorkflowsCqrsModule passes no transaction for an aggregate's
    // commit(); the wrapped WorkflowClient adds the ambient one.
    it('@StartOn on an aggregate event still rolls back with the order', async () => {
      await expect(app.get(Orders).placeViaAggregate('s-1', true)).rejects.toThrow(
        'forced rollback',
      );

      expect(await orderIds()).toEqual([]);
      expect(await instance(app, 's-1')).toBeNull();
    });

    it('@StartOn on an aggregate event commits with the order', async () => {
      await app.get(Orders).placeViaAggregate('s-2');

      expect(await orderIds()).toEqual(['s-2']);
      await expect(result(app, fulfilmentId('s-2'))).resolves.toBe('fulfilled s-2');
    });
  });
});

async function statusOf(app: TestingModule, id: string): Promise<string | undefined> {
  return ((await app.get(WorkflowClient).getStatus(id)) as { status?: string } | null)?.status;
}

async function waitUntilSuspended(app: TestingModule, id: string): Promise<void> {
  const client = app.get(WorkflowClient);
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = (await client.getStatus(id)) as { status?: string } | null;
    if (status?.status === 'suspended') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`workflow ${id} never suspended`);
}

async function pendingSignals(pg: PostgresContext): Promise<number> {
  const [row] = await pg.dataSource.query('SELECT count(*)::int AS n FROM nest_workflows.signals');
  return row?.n ?? 0;
}
