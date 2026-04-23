/**
 * Identity marker placed via `Reflect.defineMetadata` on methods that have
 * been wrapped by one of the coordinated wrapping mechanisms described in
 * ADR-005 (`TransactionalInterceptor`, `TransactionalMethodsBootstrap`,
 * and `CqrsHandlerWrapper`). Each mechanism checks this marker before
 * wrapping so a method is never wrapped twice.
 *
 * `Symbol.for` gives a process-global symbol, so multiple copies of this
 * package in the same dependency tree still resolve to the same identity.
 *
 * Internal: not re-exported from the public API. The three wrapping
 * mechanisms are the only legitimate users.
 */
export const WRAPPED_MARKER = Symbol.for('@nestjs-transactional/wrapped');
