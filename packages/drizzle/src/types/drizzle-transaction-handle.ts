import type { TransactionHandle } from '@nestjs-transactional/core';

/**
 * The part of a Drizzle PostgreSQL database, or of the `tx` its
 * `transaction()` callback receives, that the adapter uses. Structural on
 * purpose: Drizzle's own classes differ between 0.x (`PgDatabase`,
 * `PgTransaction`) and 1.0 (`PgAsyncDatabase`, `PgAsyncTransaction`), and
 * both lines fit this shape.
 */
export interface DrizzleDatabaseLike {
  transaction<T>(
    work: (tx: DrizzleDatabaseLike) => Promise<T>,
    config?: DrizzleTransactionConfig,
  ): Promise<T>;
  execute(query: string | object): Promise<unknown>;
}

/** What a Drizzle PostgreSQL `transaction()` takes as its second argument. */
export interface DrizzleTransactionConfig {
  readonly isolationLevel?:
    'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable';
  readonly accessMode?: 'read only' | 'read write';
}

/**
 * Handle of a transaction the Drizzle adapter opened. `tx` is the object
 * Drizzle handed `transaction()`'s callback: what the patched db routes
 * to, and what the bridges pass to `@nestjs/outbox` and
 * `@nestjs/workflows` as `{ transaction }`.
 */
export interface DrizzleTransactionHandle extends TransactionHandle {
  readonly tx: DrizzleDatabaseLike;
}
