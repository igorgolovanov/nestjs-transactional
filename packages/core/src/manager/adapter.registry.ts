import { Injectable } from '@nestjs/common';

import { IllegalTransactionStateError, TransactionAdapterNotFoundError } from '../types/errors';
import type { TransactionAdapter } from '../types/transaction-adapter';

/**
 * A single entry in the {@link AdapterRegistry}: an adapter instance bound to
 * its type name and instance name. Used as both the input shape of
 * {@link AdapterRegistry.register} and the element shape returned by
 * {@link AdapterRegistry.getAll}.
 */
export interface AdapterRegistration {
  /** Adapter type name, e.g. `'typeorm'`, `'prisma'`. */
  readonly adapterName: string;

  /** Instance name within the adapter type, e.g. `'primary'`, `'billing'`. */
  readonly instanceName: string;

  /** The adapter implementation registered under this (adapterName, instanceName) pair. */
  readonly adapter: TransactionAdapter;
}

/**
 * DI token for the {@link AdapterRegistry}. Consumers who need to register
 * adapters manually (for example, integration tests or custom modules)
 * can inject this token and call {@link AdapterRegistry.register}.
 */
export const ADAPTER_REGISTRY = Symbol('ADAPTER_REGISTRY');

/**
 * In-memory registry of {@link TransactionAdapter} instances, keyed by
 * `(adapterName, instanceName)`. Each adapter type (e.g. `'typeorm'`) may
 * have multiple instances (e.g. `'primary'`, `'billing'`) — the registry
 * keeps them separate so that `@Transactional({ adapterInstance: 'billing' })`
 * can target a specific one.
 *
 * The first adapter registered becomes the default; any later registration
 * can override the default by passing `isDefault = true`.
 *
 * Implementation note: the internal key format is `${adapterName}:${instanceName}`.
 * Neither `adapterName` nor `instanceName` may contain `:` — enforced by
 * convention, not at runtime.
 */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<string, TransactionAdapter>();
  private defaultAdapterName: string | null = null;
  private defaultInstanceName = 'default';

  /**
   * Register an adapter under `(registration.adapterName, registration.instanceName)`.
   *
   * The first registration always becomes the default. Passing
   * `isDefault = true` on any later registration switches the default to it.
   *
   * Re-registering the same pair overwrites the previously stored adapter;
   * the default pointer is left unchanged unless `isDefault = true` is set.
   */
  register(registration: AdapterRegistration, isDefault = false): void {
    const key = AdapterRegistry.keyFor(registration.adapterName, registration.instanceName);
    this.adapters.set(key, registration.adapter);

    if (isDefault || this.defaultAdapterName === null) {
      this.defaultAdapterName = registration.adapterName;
      this.defaultInstanceName = registration.instanceName;
    }
  }

  /**
   * Look up an adapter by `(adapterName, instanceName)`.
   *
   * @throws {TransactionAdapterNotFoundError} If no adapter is registered
   *   under that pair.
   */
  get(adapterName: string, instanceName: string): TransactionAdapter {
    const adapter = this.adapters.get(AdapterRegistry.keyFor(adapterName, instanceName));
    if (adapter === undefined) {
      throw new TransactionAdapterNotFoundError(adapterName, instanceName);
    }
    return adapter;
  }

  /**
   * Return the name of the adapter type currently marked default.
   *
   * @throws {IllegalTransactionStateError} If no adapter has been registered
   *   yet — there is no default to choose.
   */
  getDefaultAdapterName(): string {
    if (this.defaultAdapterName === null) {
      throw new IllegalTransactionStateError(
        'No default adapter registered. Register at least one adapter via ' +
          'TypeOrmTransactionalModule.forFeature() or the corresponding ' +
          'transactional module for your ORM.',
      );
    }
    return this.defaultAdapterName;
  }

  /**
   * Return the name of the default adapter instance. Defaults to `'default'`
   * before any adapter is registered — matches the common convention in
   * per-ORM `forFeature({ instanceName: 'default' })` helpers.
   */
  getDefaultInstanceName(): string {
    return this.defaultInstanceName;
  }

  /**
   * Return every registration as a new array. Used by bootstrap and
   * observability code to enumerate configured adapters at runtime.
   */
  getAll(): AdapterRegistration[] {
    return Array.from(this.adapters.entries(), ([key, adapter]) => {
      const colon = key.indexOf(':');
      return {
        adapterName: key.slice(0, colon),
        instanceName: key.slice(colon + 1),
        adapter,
      };
    });
  }

  private static keyFor(adapterName: string, instanceName: string): string {
    return `${adapterName}:${instanceName}`;
  }
}
