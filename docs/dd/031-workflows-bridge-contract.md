# DD-031: The workflows bridge contract

**Context**: `@nestjs/workflows` creates workflow instances and signals
in the application's transaction when it is given one:
`start(workflow, input, { transaction })` and `signal(signal, payload,
{ transaction })`. `WorkflowsCqrsModule` does the same for `@StartOn`
and `@SignalOn`, from the dispatcher context's `transaction`.
`@nestjs-transactional/workflows` supplies that transaction from
`@Transactional`, the way the outbox bridge does for `outbox.add()`
(DD-028). Every rule below is observable by an application and is
therefore public API under ADR-004.

**Decision**:

1. **Where.** `WorkflowClientBinding` wraps `start`, `signal` and
   `startAndWait` on the `WorkflowClient` instance, in its constructor,
   once (a symbol guard). Wrapping the instance, not providing a client
   of our own, covers every caller: application code, and the client
   `WorkflowsCqrsModule`'s publisher was injected with.
2. **Which transaction.** The bridge is bound to one DataSource
   (`'default'` unless configured). A `start()` or `signal()` without a
   `transaction` option, inside a transaction on that DataSource, gets
   `TransactionManager.nativeTransactionOf(active)`, for TypeORM the
   transactional `EntityManager`, or what `transactionResolver` returns.
   A call that passes `transaction`, or runs outside a transaction on
   that DataSource, is passed through unchanged.
3. **Pending writes.** A call the bridge gave a transaction is tracked
   with `TransactionManager.trackPending`. COMMIT waits for it, and a
   rejection rolls the transaction back. This keeps a start nobody
   awaited, such as one behind an aggregate's `commit()` on
   `@nestjs/cqrs` 11, inside the transaction.
4. **`startAndWait()`** runs without the ambient transaction. It waits
   for the instance's result, and an instance created in the caller's
   transaction would not exist before that transaction commits. Its
   internal `start()` is detached through an `AsyncLocalStorage` flag.
5. **Isolation.** On a PostgreSQL-family dialect (the adapter's
   `dialect`), a `signal()` the bridge would give a REPEATABLE_READ or
   SERIALIZABLE transaction throws `WorkflowIsolationError`, a subclass
   of `IllegalTransactionStateError`, before anything is written.
   `@nestjs/workflows`' store refuses such a signal itself, with a
   `TypeError`; the bridge's error names the DataSource and the level.
   `start()` is not checked: the store accepts it under any level, which
   the integration suite pins. An adapter that reports no dialect, or a
   transaction with no explicit isolation, is left to the store.
6. **Opting out.** Inside `@Transactional`, a workflow is started on its
   own from a method with `propagation: NOT_SUPPORTED`.

**Interaction with the transparent TypeORM patches.** `@nestjs/store-kit`'s
TypeORM executor opens its own transactions with
`dataSource.transaction()`, which goes through `dataSource.manager`.
`TransactionalTypeOrmModule` patches that getter to return the
transactional `EntityManager` inside `@Transactional` (ADR-018). So,
without this bridge, a store operation that uses its own transaction,
such as `signal()`, already joins the ambient transaction, as a nested
TypeORM transaction, while one that writes through `query()`, such as
`start()`, does not. The bridge makes both join the same way, through
`{ transaction }`, and lets the store and point 5 check the isolation.

**Rationale**: the same shape as DD-028, for the same reason: libraries
of the NestJS reliability family take the transaction explicitly, and
`@Transactional` exists so that nothing passes it by hand.

**Verified by** `packages/workflows/test/integration/bridge.integration.spec.ts`
against PostgreSQL and the real `@nestjs/workflows`, `WorkflowsModule`
with its worker and `WorkflowsCqrsModule`: `start()` and `@StartOn`
commit and roll back with the business rows, with
`TransactionalCqrsModule` and with stock `CqrsModule`; a committed
signal wakes the waiting instance and a rolled-back one does not;
`signal()` under SERIALIZABLE is refused before any write; `start()`
under SERIALIZABLE works; `startAndWait()` inside a transaction
finishes. Run without the bridge, the suite fails on the direct
`start()` rollback, the SERIALIZABLE signal, and `@StartOn` with stock
`CqrsModule`.
