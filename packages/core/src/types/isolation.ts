/**
 * Standard SQL transaction isolation level, expressed as a string union
 * rather than an enum — these values mirror an external protocol, and a
 * union keeps them treatable as plain string literals in user code.
 *
 * Refer to the SQL standard (ISO/IEC 9075) for the precise read-phenomena
 * guarantees of each level. Not every adapter/database supports every
 * level; adapters map unsupported levels to an adapter-level error.
 */
export type IsolationLevel =
  | 'READ_UNCOMMITTED'
  | 'READ_COMMITTED'
  | 'REPEATABLE_READ'
  | 'SERIALIZABLE';
