import type { TransactionHandle } from '@nestjs-transactional/core';
import type { EntityManager } from 'typeorm';

/**
 * Adapter-specific handle produced by {@link TypeOrmTransactionAdapter}.
 * Extends the core {@link TransactionHandle} with the TypeORM
 * {@link EntityManager} bound to the active transaction.
 *
 * The `EntityManager` carries its own `QueryRunner` internally, so
 * adapters and helpers can issue `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` /
 * `RELEASE SAVEPOINT` SQL via `handle.entityManager.query(...)` without
 * needing a separate query-runner reference on the handle itself.
 */
export interface TypeOrmTransactionHandle extends TransactionHandle {
  /** The TypeORM EntityManager scoped to this transaction. */
  readonly entityManager: EntityManager;
}
