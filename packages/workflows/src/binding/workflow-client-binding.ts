import { AsyncLocalStorage } from 'node:async_hooks';

import { Inject, Injectable } from '@nestjs/common';
import { WorkflowClient } from '@nestjs/workflows';
import {
  type ActiveTransaction,
  TransactionContext,
  TransactionManager,
} from '@nestjs-transactional/core';

import { WorkflowIsolationError } from '../errors.js';
import { TRANSACTIONAL_WORKFLOWS_OPTIONS } from '../module/tokens.js';

/**
 * Turns the active transaction into what `WorkflowClient.start()` and
 * `signal()` take as `transaction`. The default is the adapter's native
 * transaction (`TransactionManager.nativeTransactionOf`), for TypeORM the
 * transactional `EntityManager`.
 */
export type WorkflowTransactionResolver = (active: ActiveTransaction) => unknown;

export interface TransactionalWorkflowsOptions {
  /** The DataSource whose transactions workflows join. Defaults to `'default'`. */
  readonly dataSource?: string;
  /** See {@link WorkflowTransactionResolver}. */
  readonly transactionResolver?: WorkflowTransactionResolver;
}

const WRAPPED = Symbol.for('@nestjs-transactional/workflows/client-wrapped');

/** Dialects whose workflow store refuses a signal outside READ COMMITTED. */
const READ_COMMITTED_SIGNAL_DIALECTS = new Set(['postgres', 'aurora-postgres']);

type Options = { transaction?: unknown } | undefined;
type ClientMethod = (...args: unknown[]) => Promise<unknown>;

/**
 * Makes `@nestjs/workflows`' `WorkflowClient` join the transaction
 * `@Transactional` opened (DD-031).
 *
 * It wraps `start()` and `signal()` on the client instance, so every
 * caller is covered: application code, and `WorkflowsCqrsModule`'s
 * publisher behind `@StartOn` and `@SignalOn`. A call without a
 * `transaction` option, inside a transaction on the configured
 * DataSource, gets that transaction: the instance or the signal commits
 * or rolls back with the business rows. A call that passes `transaction`
 * itself, or runs outside a transaction, is left as it is.
 *
 * `startAndWait()` keeps creating the instance on its own: it waits for
 * the result, and an instance created in a transaction would not exist
 * until that transaction commits.
 */
@Injectable()
export class WorkflowClientBinding {
  private readonly dataSource: string;
  private readonly resolveTransaction: WorkflowTransactionResolver;
  private readonly detached = new AsyncLocalStorage<true>();

  constructor(
    client: WorkflowClient,
    private readonly manager: TransactionManager,
    @Inject(TRANSACTIONAL_WORKFLOWS_OPTIONS) options: TransactionalWorkflowsOptions = {},
  ) {
    this.dataSource = options.dataSource ?? 'default';
    this.resolveTransaction =
      options.transactionResolver ?? ((active) => manager.nativeTransactionOf(active));
    // In the constructor, like WorkflowsCqrsModule's publisher: nothing
    // may start a workflow before the wrap is in place.
    this.wrap(client);
  }

  private wrap(client: WorkflowClient): void {
    const target = client as unknown as Record<PropertyKey, unknown>;
    if (target[WRAPPED] === true) {
      return;
    }
    const start = client.start.bind(client) as ClientMethod;
    const signal = client.signal.bind(client) as ClientMethod;
    const startAndWait = client.startAndWait.bind(client) as ClientMethod;

    target.start = (workflow: unknown, input: unknown, options?: Options) =>
      this.call(start, 'start', [workflow, input], options);
    target.signal = (name: unknown, payload: unknown, options?: Options) =>
      this.call(signal, 'signal', [name, payload], options);
    target.startAndWait = (...args: unknown[]) =>
      this.detached.run(true, () => startAndWait(...args));
    target[WRAPPED] = true;
  }

  private call(
    method: ClientMethod,
    kind: 'start' | 'signal',
    args: unknown[],
    options: Options,
  ): Promise<unknown> {
    const active =
      options?.transaction === undefined && this.detached.getStore() !== true
        ? TransactionContext.getActiveTransactionByDataSource(this.dataSource)
        : undefined;
    if (active === undefined) {
      return method(...args, options);
    }
    if (kind === 'signal') {
      this.assertSignalIsolation(active);
    }
    const result = method(...args, {
      ...options,
      transaction: this.resolveTransaction(active),
    });
    // A caller that does not await, such as an aggregate's commit() on
    // @nestjs/cqrs 11, must still have the write land before COMMIT.
    this.manager.trackPending(active, result);
    return result;
  }

  private assertSignalIsolation(active: ActiveTransaction): void {
    const isolation = active.options.isolation;
    if (
      isolation === undefined ||
      isolation === 'READ_COMMITTED' ||
      isolation === 'READ_UNCOMMITTED'
    ) {
      return;
    }
    const dialect = this.manager.dialectOf(active);
    if (dialect !== undefined && READ_COMMITTED_SIGNAL_DIALECTS.has(dialect)) {
      throw new WorkflowIsolationError(active.adapterInstanceName, isolation);
    }
  }
}
