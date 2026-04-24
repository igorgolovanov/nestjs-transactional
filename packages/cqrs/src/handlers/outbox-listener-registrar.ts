/**
 * Minimal structural contract for an outbox listener registrar,
 * declared here (and injected via {@link OUTBOX_LISTENER_REGISTRAR})
 * rather than imported from `@nestjs-transactional/outbox-core`
 * directly — keeps the cqrs package usable without the outbox stack.
 *
 * `@nestjs-transactional/outbox-core`'s `OutboxListenerRegistry`
 * satisfies this interface structurally (its `register` method
 * accepts exactly this shape). Wire the token in the host application
 * when the outbox is enabled:
 *
 * ```ts
 * providers: [
 *   {
 *     provide: OUTBOX_LISTENER_REGISTRAR,
 *     useExisting: OutboxListenerRegistry,
 *   },
 * ]
 * ```
 *
 * `OutboxModule` from outbox-core binds this automatically once
 * wired — consumers who construct the registry manually need to
 * declare the binding themselves.
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
 * into `ApplicationModuleHandlerScanner`. When unbound, the scanner
 * falls back to in-memory registration via
 * {@link TransactionalEventDispatcher}.
 */
export const OUTBOX_LISTENER_REGISTRAR = Symbol('OUTBOX_LISTENER_REGISTRAR');
