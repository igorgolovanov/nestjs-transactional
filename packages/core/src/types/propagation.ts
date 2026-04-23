/**
 * Transaction propagation mode — how `@Transactional` behaves when invoked
 * in the presence (or absence) of an already-active transaction.
 *
 * Modeled on Spring Framework's
 * `org.springframework.transaction.annotation.Propagation`.
 *
 * @see https://docs.spring.io/spring-framework/reference/data-access/transaction/declarative/tx-propagation.html
 */
export enum PropagationMode {
  /**
   * Join the current transaction if one exists; otherwise start a new one.
   * The default mode — the common choice for business methods that want
   * transactional safety without caring where they are called from.
   */
  REQUIRED = 'REQUIRED',

  /**
   * Always start a new transaction, suspending the current one if present.
   * The suspended transaction resumes when the new one completes (commit or
   * rollback).
   *
   * Use for operations that must succeed or fail independently of the
   * caller's transaction — e.g. audit logging that should persist even when
   * the caller rolls back.
   */
  REQUIRES_NEW = 'REQUIRES_NEW',

  /**
   * Run inside a nested transaction using `SAVEPOINT` semantics when a
   * transaction is active. The nested scope can be rolled back without
   * affecting the outer transaction.
   *
   * Requires adapter support for savepoints. On Postgres/MySQL via TypeORM
   * this is implemented with `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`.
   *
   * Outside of an existing transaction, behaves like {@link REQUIRED}.
   */
  NESTED = 'NESTED',

  /**
   * Join the current transaction if one exists; otherwise run
   * non-transactionally. Useful for read-oriented operations that should
   * participate when called from a transactional context but not start
   * one of their own.
   */
  SUPPORTS = 'SUPPORTS',

  /**
   * Run non-transactionally, suspending the current transaction if one
   * exists. The caller's transaction resumes after the method returns.
   */
  NOT_SUPPORTED = 'NOT_SUPPORTED',

  /**
   * Run non-transactionally; throw `IllegalTransactionStateError` if a
   * transaction is active. Use as an assertion that a method must not be
   * invoked inside a transaction.
   */
  NEVER = 'NEVER',

  /**
   * Join the current transaction if one exists; throw
   * `IllegalTransactionStateError` if not. Use as an assertion that the
   * caller must already be inside an active transaction.
   */
  MANDATORY = 'MANDATORY',
}
