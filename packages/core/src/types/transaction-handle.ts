/**
 * Opaque handle returned by a `TransactionAdapter` while a transaction is
 * active. Adapter implementations extend this interface with their own
 * runtime fields (for example, the TypeORM adapter adds `entityManager`).
 *
 * Core code only sees {@link id} and {@link adapterName}; adapter-specific
 * helpers cast to the narrower handle type to read their own fields.
 */
export interface TransactionHandle {
  /**
   * Unique identifier of this transaction, assigned by the adapter on
   * begin. Used by observability hooks, logging, and debugging to correlate
   * events with a single transaction lifetime.
   */
  readonly id: string;

  /**
   * Name of the adapter that owns this handle. Matches the adapter's
   * `name` property and the key under which it is registered in the
   * `AdapterRegistry`.
   */
  readonly adapterName: string;
}
