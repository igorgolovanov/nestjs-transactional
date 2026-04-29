/**
 * Minimal structural contract for an outbox listener registrar,
 * declared here (and injected via {@link OUTBOX_LISTENER_REGISTRAR})
 * rather than imported from `@nestjs-transactional/outbox`
 * directly — keeps the cqrs package usable without the outbox stack.
 *
 * `@nestjs-transactional/outbox`'s `OutboxListenerRegistry`
 * satisfies this interface structurally (its `register` method
 * accepts exactly this shape). The outbox package's
 * `MultiDsOutboxListenerRegistrar` (Phase 14.3.1) is a smarter
 * implementation that walks every per-dataSource event-type registry
 * to resolve which dataSource owns each listener's event class and
 * routes the registration to the matching per-DS registry — so a
 * single binding handles arbitrary multi-dataSource deployments.
 *
 * **Auto-binding (Phase 14.3.1).** `OutboxModule.forRoot` binds this
 * token to `MultiDsOutboxListenerRegistrar` automatically on the
 * first `forRoot` call. Consumers do NOT need to declare the binding
 * themselves; the registrar is in place by the time the cqrs
 * `IntegrationEventsHandlerScanner` runs its `onModuleInit`. Manual
 * binding remains supported for advanced cases (custom routing
 * policy, structural decoupling tests).
 *
 * Cross-package token identity is via `Symbol.for(...)` so the cqrs
 * declaration and the outbox auto-binding refer to the same Symbol
 * without either package importing from the other (Convention #8 —
 * mirrors `WRAPPED_MARKER`).
 */
export interface OutboxListenerRegistrar {
  register(listener: {
    readonly id: string;
    readonly eventType: string;
    readonly invoke: (event: unknown) => Promise<void>;
  }): void;
}

/**
 * DI token for the optional {@link OutboxListenerRegistrar} injected
 * into `IntegrationEventsHandlerScanner`. When unbound, the scanner
 * falls back to in-memory registration via
 * {@link TransactionalEventDispatcher}.
 *
 * `Symbol.for(...)` (not `Symbol(...)`) — Phase 14.3.1: the outbox
 * package auto-binds this token to its `MultiDsOutboxListenerRegistrar`
 * via `Symbol.for` lookup on the same key. Both packages thereby
 * refer to the same Symbol identity without a direct import in
 * either direction.
 */
export const OUTBOX_LISTENER_REGISTRAR = Symbol.for(
  '@nestjs-transactional/cqrs/outbox-listener-registrar',
);
