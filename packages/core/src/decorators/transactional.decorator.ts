import { PropagationMode } from '../types/propagation';
import type { ExtendedTransactionOptions } from '../types/transaction-options';

/**
 * Metadata key under which {@link Transactional} stores its options on a
 * target (a method's function object or a class constructor). Exposed for
 * advanced introspection; most code should use
 * {@link getTransactionalMetadata}.
 */
export const TRANSACTIONAL_METADATA = Symbol('TRANSACTIONAL_METADATA');

/**
 * Shape of the metadata attached by {@link Transactional}. Currently an
 * alias for {@link ExtendedTransactionOptions} — kept as a distinct name so
 * the decorator's public surface is self-documenting and so decorator-only
 * options can be added later without touching the manager's options type.
 */
export type TransactionalMetadata = ExtendedTransactionOptions;

/**
 * Mark a method or a class as transactional.
 *
 * **Metadata-only**: this decorator does NOT wrap the method at decoration
 * time. The actual wrapping is performed at runtime by the three coordinated
 * mechanisms described in ADR-005 — `TransactionalInterceptor` for
 * request-boundary handlers, `TransactionalMethodsBootstrap` for regular
 * `@Injectable` providers, and `CqrsHandlerWrapper` for CQRS handlers.
 *
 * Usage:
 * - As a method decorator, the metadata is written onto `descriptor.value`
 *   (the method function).
 * - As a class decorator, the metadata is written onto the class
 *   constructor. Downstream wrapping mechanisms treat every method of the
 *   class as transactional with these options (unless a method has its own
 *   `@Transactional` which overrides).
 *
 * Default propagation is {@link PropagationMode.REQUIRED}.
 */
export function Transactional(
  options: Partial<TransactionalMetadata> = {},
): MethodDecorator & ClassDecorator {
  const metadata: TransactionalMetadata = {
    propagation: PropagationMode.REQUIRED,
    ...options,
  };

  const decorator: MethodDecorator & ClassDecorator = (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const methodTarget: unknown = descriptor?.value;
    if (typeof methodTarget === 'function') {
      Reflect.defineMetadata(TRANSACTIONAL_METADATA, metadata, methodTarget);
    } else {
      Reflect.defineMetadata(TRANSACTIONAL_METADATA, metadata, target);
    }
  };

  return decorator;
}

/**
 * Alias for `@Transactional({ readOnly: true })`. Use on query methods that
 * must not mutate state. Options are applied first and the `readOnly: true`
 * flag is overlaid on top, so callers cannot turn it off from here — use
 * `@Transactional` directly if that is the intent.
 */
export const ReadOnly = (
  options: Partial<TransactionalMetadata> = {},
): MethodDecorator & ClassDecorator => Transactional({ ...options, readOnly: true });

/**
 * Alias for `@Transactional({ adapterInstance })`. Targets a specific
 * adapter instance, for multi-datasource setups:
 *
 * ```ts
 * @TransactionalOn('billing')
 * async issueInvoice() { ... }
 * ```
 *
 * The `adapterInstance` argument overrides any `adapterInstance` set in the
 * options object.
 */
export const TransactionalOn = (
  adapterInstance: string,
  options: Partial<TransactionalMetadata> = {},
): MethodDecorator & ClassDecorator => Transactional({ ...options, adapterInstance });

/**
 * Read the {@link TransactionalMetadata} stored by {@link Transactional} on
 * `target`. Returns `undefined` when the target was not decorated.
 *
 * @param target - A class constructor (for class-level metadata) or a
 *   method function (for method-level metadata).
 */
export function getTransactionalMetadata(target: object): TransactionalMetadata | undefined {
  const value: unknown = Reflect.getMetadata(TRANSACTIONAL_METADATA, target);
  return value as TransactionalMetadata | undefined;
}
