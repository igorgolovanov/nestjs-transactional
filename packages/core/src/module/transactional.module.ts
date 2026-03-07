import {
  type DynamicModule,
  type FactoryProvider,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';

import { TransactionalMethodsBootstrap } from '../bootstrap/transactional-methods.bootstrap';
import { TransactionContextView } from '../context/transaction-context-view';
import { TransactionalInterceptor } from '../interceptor/transactional.interceptor';
import {
  ADAPTER_REGISTRY,
  type AdapterRegistration,
  AdapterRegistry,
} from '../manager/adapter.registry';
import { TransactionManager } from '../manager/transaction.manager';
import {
  TRANSACTION_OBSERVERS,
  type TransactionObserver,
} from '../observability/transaction-observer';
import {
  getTransactionContextToken,
  getTransactionManagerToken,
  getTransactionalAdapterToken,
} from '../tokens/token-utils';
import type { TransactionAdapter } from '../types/transaction-adapter';

/**
 * Options accepted by {@link TransactionalModule.forRoot}.
 */
export interface TransactionalModuleOptions {
  /**
   * When `true`, the module is registered as `@Global()` — its exports are
   * available app-wide without being re-imported. Defaults to `false`.
   */
  readonly isGlobal?: boolean;

  /**
   * When `true` (default), registers {@link TransactionalInterceptor} as
   * `APP_INTERCEPTOR`. Set to `false` to opt out — for instance to wire the
   * interceptor manually on specific controllers.
   */
  readonly registerInterceptor?: boolean;

  /**
   * When `true` (default), registers {@link TransactionalMethodsBootstrap}
   * — an `OnApplicationBootstrap` service that wraps every
   * `@Transactional()` method on plain `@Injectable()` providers with
   * `TransactionManager.run(...)`. Set to `false` to opt out when the
   * application has no service-level `@Transactional` methods, or when
   * another mechanism handles wrapping.
   */
  readonly registerMethodsBootstrap?: boolean;

  /**
   * Single adapter shorthand (DD-021). Registers the adapter under
   * `(adapter.name, adapter.dataSourceName)` and exposes per-dataSource
   * DI tokens (`getTransactionalAdapterToken`,
   * `getTransactionContextToken`, `getTransactionManagerToken`).
   *
   * Recommended for the common single-adapter case. For multi-adapter
   * setups, list every adapter in {@link adapters} — this module
   * supports a single `forRoot()` call only (NestJS provider
   * deduplication makes multi-`forRoot()` infeasible without
   * coordination state we deliberately do not maintain).
   */
  readonly adapter?: TransactionAdapter;

  /**
   * Multiple adapters as full {@link AdapterRegistration} entries, for
   * advanced multi-adapter setups. The first entry becomes the default
   * unless a later entry is passed with `isDefault: true` via a manual
   * registration.
   *
   * For multi-adapter, register every adapter through this single
   * array — multi-`forRoot()` calls are not supported.
   */
  readonly adapters?: readonly AdapterRegistration[];

  /**
   * Transaction observers registered under {@link TRANSACTION_OBSERVERS}.
   * Omit to leave the token unbound — `TransactionManager` falls back to an
   * empty list. Provide your own `TRANSACTION_OBSERVERS` provider instead
   * if your observers require DI resolution.
   */
  readonly observers?: readonly TransactionObserver[];
}

/**
 * Shape returned by {@link TransactionalModuleAsyncOptions.useFactory}.
 * Only `adapters` and `observers` are resolvable asynchronously —
 * `isGlobal` and `registerInterceptor` remain static because they must be
 * known at module definition time.
 */
export interface TransactionalModuleAsyncFactoryResult {
  /**
   * Single adapter shorthand — equivalent to the {@link adapters} array
   * but lets the factory return one adapter directly. See
   * {@link TransactionalModuleOptions.adapter} for semantics.
   *
   * Per-dataSource DI tokens (`getTransactionalAdapterToken` etc.) are
   * NOT registered for `forRootAsync` because the dataSource name is
   * only known after the async factory runs, while NestJS provider
   * tokens must be declared statically. Use synchronous
   * `forRoot({ adapter })` if per-dataSource tokens are required.
   */
  readonly adapter?: TransactionAdapter;
  readonly adapters?: readonly AdapterRegistration[];
  readonly observers?: readonly TransactionObserver[];
}

/**
 * Options for {@link TransactionalModule.forRootAsync}. Mirrors the shape
 * of other `*Async` helpers in the NestJS ecosystem.
 */
export interface TransactionalModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly isGlobal?: boolean;
  readonly registerInterceptor?: boolean;
  readonly registerMethodsBootstrap?: boolean;
  readonly useFactory: (
    ...args: never[]
  ) => Promise<TransactionalModuleAsyncFactoryResult> | TransactionalModuleAsyncFactoryResult;
  readonly inject?: readonly InjectionToken[];
}

const ASYNC_OPTIONS_TOKEN = Symbol('TRANSACTIONAL_ASYNC_OPTIONS');

/**
 * NestJS module that wires the core transactional runtime:
 * {@link AdapterRegistry}, {@link TransactionManager}, and (by default) the
 * global {@link TransactionalInterceptor}. Import it once at the
 * application root via {@link TransactionalModule.forRoot} or the async
 * {@link TransactionalModule.forRootAsync}.
 *
 * Adapter-specific registration (TypeORM, Prisma, ...) is handled by the
 * corresponding integration package's `forFeature` helper — this module
 * only provides the adapter-agnostic infrastructure.
 */
@Module({})
export class TransactionalModule {
  /**
   * Synchronous registration.
   *
   * @example
   * ```ts
   * @Module({
   *   imports: [
   *     TransactionalModule.forRoot({
   *       isGlobal: true,
   *       adapters: [
   *         { adapterName: 'typeorm', instanceName: 'default', adapter },
   *       ],
   *     }),
   *   ],
   * })
   * export class AppModule {}
   * ```
   */
  static forRoot(options: TransactionalModuleOptions = {}): DynamicModule {
    const registrations = resolveRegistrations(options);
    const providers: Provider[] = [
      {
        provide: ADAPTER_REGISTRY,
        useFactory: (): AdapterRegistry => buildRegistry(registrations),
      },
      TransactionManager,
      ...buildPerDataSourceProviders(registrations),
    ];

    if (options.observers !== undefined) {
      providers.push({
        provide: TRANSACTION_OBSERVERS,
        useValue: [...options.observers],
      });
    }

    if (options.registerInterceptor !== false) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: TransactionalInterceptor,
      });
    }

    if (options.registerMethodsBootstrap !== false) {
      providers.push(TransactionalMethodsBootstrap);
    }

    return {
      module: TransactionalModule,
      global: options.isGlobal ?? false,
      imports: [DiscoveryModule],
      providers,
      exports: [
        TransactionManager,
        ADAPTER_REGISTRY,
        ...buildPerDataSourceExports(registrations),
      ],
    };
  }

  /**
   * Asynchronous registration. Useful when adapter configuration depends on
   * runtime state (config service, environment, etc.). `isGlobal` and
   * `registerInterceptor` remain static top-level flags.
   *
   * @example
   * ```ts
   * TransactionalModule.forRootAsync({
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({
   *     adapters: [buildAdapterFromConfig(config)],
   *   }),
   * });
   * ```
   */
  static forRootAsync(options: TransactionalModuleAsyncOptions): DynamicModule {
    const asyncOptionsProvider: FactoryProvider = {
      provide: ASYNC_OPTIONS_TOKEN,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };

    const registryProvider: FactoryProvider = {
      provide: ADAPTER_REGISTRY,
      useFactory: (opts: TransactionalModuleAsyncFactoryResult): AdapterRegistry =>
        buildRegistry(resolveRegistrations(opts)),
      inject: [ASYNC_OPTIONS_TOKEN],
    };

    const observersProvider: FactoryProvider = {
      provide: TRANSACTION_OBSERVERS,
      useFactory: (opts: TransactionalModuleAsyncFactoryResult): readonly TransactionObserver[] =>
        opts.observers ? [...opts.observers] : [],
      inject: [ASYNC_OPTIONS_TOKEN],
    };

    const providers: Provider[] = [
      asyncOptionsProvider,
      registryProvider,
      observersProvider,
      TransactionManager,
    ];

    if (options.registerInterceptor !== false) {
      providers.push({
        provide: APP_INTERCEPTOR,
        useClass: TransactionalInterceptor,
      });
    }

    if (options.registerMethodsBootstrap !== false) {
      providers.push(TransactionalMethodsBootstrap);
    }

    return {
      module: TransactionalModule,
      global: options.isGlobal ?? false,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers,
      exports: [TransactionManager, ADAPTER_REGISTRY],
    };
  }
}

function buildRegistry(adapters: readonly AdapterRegistration[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  return registry;
}

/**
 * Resolve user-facing options (`adapter` | `adapters`) into the canonical
 * `AdapterRegistration[]` shape. The single `adapter` shortcut derives
 * `(adapterName, instanceName)` from the adapter's own properties
 * (`adapter.name`, `adapter.dataSourceName`) — the user does not need
 * to repeat them.
 *
 * Both options can be provided together; the single-form entry is
 * appended to the array. Duplicate dataSource names across the
 * combined list are surfaced at registry-resolution time, not here.
 */
function resolveRegistrations(
  options: { readonly adapter?: TransactionAdapter; readonly adapters?: readonly AdapterRegistration[] },
): readonly AdapterRegistration[] {
  const fromArray = options.adapters ?? [];
  if (options.adapter === undefined) {
    return fromArray;
  }
  const single: AdapterRegistration = {
    adapterName: options.adapter.name,
    instanceName: options.adapter.dataSourceName,
    adapter: options.adapter,
  };
  return [...fromArray, single];
}

/**
 * Per-dataSource DI providers for ADR-018's token-based access pattern.
 * For each registered adapter:
 * - `getTransactionalAdapterToken(dataSource)` resolves to the adapter
 *   instance directly.
 * - `getTransactionContextToken(dataSource)` resolves to a
 *   {@link TransactionContextView} pre-bound to the dataSource.
 * - `getTransactionManagerToken(dataSource)` aliases the singleton
 *   `TransactionManager` via `useExisting`. Per-call dataSource
 *   selection still goes through `manager.run({ dataSource })` —
 *   this token exists for symmetry with `@nestjs/typeorm`'s
 *   per-dataSource injection pattern (DD-022).
 */
function buildPerDataSourceProviders(
  registrations: readonly AdapterRegistration[],
): Provider[] {
  const providers: Provider[] = [];
  for (const reg of registrations) {
    const ds = reg.instanceName;
    providers.push({
      provide: getTransactionalAdapterToken(ds),
      useValue: reg.adapter,
    });
    providers.push({
      provide: getTransactionContextToken(ds),
      useValue: new TransactionContextView(ds),
    });
    providers.push({
      provide: getTransactionManagerToken(ds),
      useExisting: TransactionManager,
    });
  }
  return providers;
}

function buildPerDataSourceExports(
  registrations: readonly AdapterRegistration[],
): InjectionToken[] {
  const exports: InjectionToken[] = [];
  for (const reg of registrations) {
    const ds = reg.instanceName;
    exports.push(getTransactionalAdapterToken(ds));
    exports.push(getTransactionContextToken(ds));
    exports.push(getTransactionManagerToken(ds));
  }
  return exports;
}
