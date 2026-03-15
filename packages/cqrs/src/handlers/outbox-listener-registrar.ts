/**
 * Minimal structural contract for an outbox listener registrar,
 * declared here (and injected via {@link OUTBOX_LISTENER_REGISTRAR})
 * rather than imported from `@nestjs-transactional/outbox`
 * directly — keeps the cqrs package usable without the outbox stack.
 *
 * `@nestjs-transactional/outbox`'s `OutboxListenerRegistry`
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
 * `OutboxModule` from outbox binds this automatically once
 * wired — consumers who construct the registry manually need to
 * declare the binding themselves.
 *
 * **Multi-dataSource (Phase 14.7).** `OutboxListenerRegistry` is
 * registered per-dataSource (one per `OutboxModule.forRoot()` —
 * ADR-019). For multi-DS deployments with non-default-DS handlers,
 * resolve the per-DS registry token explicitly and bridge it via
 * `useExisting: getOutboxListenerRegistryToken('billing')` (or
 * similar). The default-DS registry remains aliased under the
 * `OutboxListenerRegistry` class token. See CLAUDE.md "Known
 * Limitations (Phase 14)" — the bundled scanner gap (Phase 14.3.1
 * follow-up) covers automating this.
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
 */
export const OUTBOX_LISTENER_REGISTRAR = Symbol('OUTBOX_LISTENER_REGISTRAR');
