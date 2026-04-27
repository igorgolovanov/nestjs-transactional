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
 * Synchronous options for {@link TransactionalModule.forRoot}.
 *
 * Multi-dataSource deployments call `forRoot` once per dataSource:
 *
 * ```ts
 * TransactionalModule.forRoot({ adapter: defaultAdapter }),                 // default
 * TransactionalModule.forRoot({ adapter: billingAdapter }),                 // billing
 * TransactionalModule.forRoot({ adapter: inventoryAdapter }),               // inventory
 * ```
 *
 * Matches NestJS conventions (`TypeOrmModule`, `MongooseModule`,
 * `ClientsModule`) and aligns with `OutboxModule.forRoot` from
 * Phase 14.3.2 (ADR-019). Cross-call coordination of singletons
 * (`AdapterRegistry`, `TransactionManager`, `APP_INTERCEPTOR`,
 * `TransactionalMethodsBootstrap`, `TRANSACTION_OBSERVERS`) lives in
 * static class storage on {@link TransactionalModule}, mirroring
 * `@nestjs/typeorm`'s `EntitiesMetadataStorage` pattern.
 *
 * The `infrastructure-only` shorthand `TransactionalModule.forRoot({})`
 * (no adapter) is preserved for setups where the adapter is contributed
 * by an integration package's `forFeature` (e.g.
 * `TypeOrmTransactionalModule.forFeature` calls `AdapterRegistry.register`
 * imperatively at module-init time).
 *
 * Q5 invariants on multi-call:
 * - Two calls with the same `adapter.dataSourceName` throw at module-
 *   definition time.
 * - Two `forRoot({})` calls (both infrastructure-only) — the second
 *   throws because infrastructure has already been registered.
 * - `forRoot({})` then `forRoot({ adapter })` works.
 * - `forRoot({ adapter A })` then `forRoot({ adapter B })` (different
 *   dataSource) works.
 * - `forRoot({ adapter })` then `forRoot({})` throws (infrastructure
 *   already registered).
 *
 * Tests that build multiple modules sequentially MUST call
 * {@link TransactionalModule.resetForTesting} in `beforeEach`.
 */
export interface TransactionalModuleOptions {
  /**
   * Adapter instance to register. The adapter's `dataSourceName`
   * keys this registration; duplicate dataSource names across
   * `forRoot` calls throw. When omitted, this call only registers
   * the process-wide infrastructure — adapters are then expected
   * from an integration package (e.g.
   * `TypeOrmTransactionalModule.forFeature`).
   */
  readonly adapter?: TransactionAdapter;

  /**
   * When `true` (default — Phase 14.10), the module is registered as
   * `@Global()` — its exports are available app-wide without being
   * re-imported. Honored per call (each `forRoot` builds its own
   * `DynamicModule` with its own `global` flag). Multi-call setups
   * effectively require `isGlobal: true` on at least the first call
   * for `TransactionManager` and `AdapterRegistry` to be visible
   * across sibling DynamicModules; the default flip aligns the API
   * with `OutboxModule` (also default-global) and removes a
   * common-case footgun.
   */
  readonly isGlobal?: boolean;

  /**
   * When `true` (default), the FIRST `forRoot` call registers
   * {@link TransactionalInterceptor} as `APP_INTERCEPTOR`. Honored
   * only on the first call — the value passed to subsequent calls is
   * ignored (the interceptor is process-wide).
   */
  readonly registerInterceptor?: boolean;

  /**
   * When `true` (default), the FIRST `forRoot` call registers
   * {@link TransactionalMethodsBootstrap} — an
   * `OnApplicationBootstrap` service that wraps every `@Transactional()`
   * method on plain `@Injectable()` providers with
   * `TransactionManager.run(...)`. Honored only on the first call;
   * subsequent calls' value is ignored.
   */
  readonly registerMethodsBootstrap?: boolean;

  /**
   * Transaction observers registered under {@link TRANSACTION_OBSERVERS}.
   * Honored only on the FIRST `forRoot` call (Q2 invariant) — passing
   * `observers` to a subsequent call throws at module-definition time.
   * Provide your own `TRANSACTION_OBSERVERS` provider via standard DI
   * if your observers need DI resolution.
   */
  readonly observers?: readonly TransactionObserver[];
}

/**
 * Result shape resolved by {@link TransactionalModuleAsyncOptions.useFactory}.
 *
 * Per-DS DI tokens (`getTransactionalAdapterToken(ds)`,
 * `getTransactionContextToken(ds)`,
 * `getTransactionManagerToken(ds)`) are NOT registered for
 * `forRootAsync` because the dataSource name is only known after the
 * async factory runs, while NestJS provider tokens must be declared
 * statically. If per-DS injection matters, use sync
 * `forRoot({ adapter })` instead — build the adapter configuration
 * through your own async logic before reaching the module imports.
 */
export interface TransactionalModuleAsyncFactoryResult {
  readonly adapter?: TransactionAdapter;
  readonly observers?: readonly TransactionObserver[];
}

/**
 * Asynchronous options for {@link TransactionalModule.forRootAsync}.
 * Mirrors the multi-call pattern of `forRoot`: each call registers one
 * dataSource's adapter (resolved asynchronously). See
 * {@link TransactionalModuleAsyncFactoryResult} for the per-DS-token
 * limitation.
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

const ASYNC_OPTIONS_TOKEN = (id: number): symbol =>
  Symbol(`TRANSACTIONAL_ASYNC_OPTIONS[${id}]`);
const ASYNC_REGISTRATION_TOKEN = (id: number): symbol =>
  Symbol(`TRANSACTIONAL_ASYNC_REGISTRATION[${id}]`);

/**
 * NestJS module that wires the core transactional runtime:
 * {@link AdapterRegistry}, {@link TransactionManager}, and (by
 * default) the global {@link TransactionalInterceptor}. ADR-018
 * shape — multi-dataSource deployments call {@link forRoot} once per
 * dataSource. Static class storage coordinates singletons across
 * calls (mirrors Phase 14.3.2 `OutboxModule` per ADR-019).
 *
 * The first call registers the process-wide infrastructure; subsequent
 * calls only contribute per-dataSource providers. Adapter-specific
 * registration (TypeORM, Prisma, ...) is handled by the integration
 * package's `forFeature` helper — this module only provides the
 * adapter-agnostic infrastructure.
 */
@Module({})
export class TransactionalModule {
  /**
   * @internal
   * Process-wide map of adapter-bearing `forRoot` calls, keyed by
   * `adapter.dataSourceName`. Used for dedup of duplicate dataSource
   * registrations at module-definition time. The {@link AdapterRegistry}
   * itself is populated imperatively by per-DS adapter providers
   * (factory side effect) — this Map exists for `forRoot`-call-time
   * coordination only.
   *
   * Tests that build multiple modules sequentially MUST call
   * {@link resetForTesting} between cases.
   */
  private static readonly registrations = new Map<string, AdapterRegistration>();

  /**
   * @internal
   * `true` once any `forRoot` (or `forRootAsync`) call has run.
   * First-call-special providers (singletons, interceptor, methods
   * bootstrap, observers) are only registered when this is `false` at
   * the start of a call.
   *
   * Tracked separately from {@link registrations} because the
   * shorthand `forRoot({})` (no adapter) still registers
   * infrastructure but contributes nothing to the Map. Q5 invariant:
   * a second `forRoot({})` after infrastructure is already registered
   * throws — the first call already wired everything; the second has
   * nothing to add.
   */
  private static infrastructureRegistered = false;

  /**
   * @internal
   * Counter for `forRootAsync`-only token uniqueness. Not strictly
   * needed for `Symbol()` (each call returns a unique symbol
   * regardless of description), but keeping a numeric id makes
   * provider names deterministic in error messages.
   */
  private static asyncCounter = 0;

  /**
   * Test-only — drop every registration so a subsequent `forRoot`
   * starts from a clean slate. Mirrors the pattern used with
   * `OutboxModule.resetForTesting` and `EntitiesMetadataStorage` in
   * `@nestjs/typeorm` test suites.
   *
   * Production code should never call this. Calling at runtime after
   * the module has been initialised does NOT clear the provider tree
   * NestJS already built — it only affects subsequent `forRoot` calls.
   *
   * @internal
   */
  static resetForTesting(): void {
    this.registrations.clear();
    this.infrastructureRegistered = false;
    this.asyncCounter = 0;
  }

  /**
   * Synchronous registration. Each call registers one dataSource's
   * adapter (or, with `adapter` omitted, only the process-wide
   * infrastructure for an integration package's `forFeature` to write
   * into).
   *
   * @example Single-adapter
   * ```ts
   * TransactionalModule.forRoot({ isGlobal: true, adapter })
   * ```
   *
   * @example Multi-adapter (multiple calls)
   * ```ts
   * TransactionalModule.forRoot({ isGlobal: true, adapter: defaultAdapter }),
   * TransactionalModule.forRoot({ adapter: billingAdapter }),
   * TransactionalModule.forRoot({ adapter: inventoryAdapter }),
   * ```
   *
   * @example Infrastructure-only (TypeORM forFeature handles adapters)
   * ```ts
   * TransactionalModule.forRoot({ isGlobal: true }),
   * TypeOrmTransactionalModule.forFeature({ dataSource }),
   * ```
   */
  static forRoot(options: TransactionalModuleOptions = {}): DynamicModule {
    const isFirst = !this.infrastructureRegistered;
    const adapter = options.adapter;

    if (adapter !== undefined) {
      const ds = adapter.dataSourceName;
      if (this.registrations.has(ds)) {
        throw new Error(
          `TransactionalModule.forRoot — dataSource '${ds}' already registered. ` +
            `dataSource names must be unique across forRoot calls. ` +
            `If this is a test, call TransactionalModule.resetForTesting() between cases.`,
        );
      }
      this.registrations.set(ds, {
        adapterName: adapter.name,
        instanceName: ds,
        adapter,
      });
    } else if (!isFirst) {
      throw new Error(
        `TransactionalModule.forRoot({}) called without adapter, but infrastructure ` +
          `has already been registered by an earlier forRoot call. Pass an adapter to ` +
          `register an additional dataSource, or omit this call entirely. ` +
          `If this is a test, call TransactionalModule.resetForTesting() between cases.`,
      );
    }

    if (!isFirst && options.observers !== undefined) {
      throw new Error(
        `TransactionalModule.forRoot({ observers }) — observers can only be passed in ` +
          `the first forRoot call. Subsequent calls must omit the observers field.`,
      );
    }

    const providers: Provider[] = [];
    const exportTokens: InjectionToken[] = [];

    if (adapter !== undefined) {
      providers.push(...buildPerDataSourceProviders(adapter));
      exportTokens.push(...buildPerDataSourceExports(adapter.dataSourceName));
    }

    if (isFirst) {
      this.infrastructureRegistered = true;

      // ADAPTER_REGISTRY factory closes over the static `registrations`
      // Map. By the time NestJS resolves this factory, every synchronous
      // `forRoot` body has run and the Map is fully populated. Pattern
      // mirrors Phase 14.3.2 `OutboxModule` per ADR-019.
      providers.push({
        provide: ADAPTER_REGISTRY,
        useFactory: (): AdapterRegistry =>
          buildRegistryFromStaticStorage(TransactionalModule),
      });
      providers.push({
        provide: AdapterRegistry,
        useExisting: ADAPTER_REGISTRY,
      });
      providers.push(TransactionManager);

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

      exportTokens.push(TransactionManager, ADAPTER_REGISTRY, AdapterRegistry);
    }

    return {
      module: TransactionalModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule],
      providers,
      exports: exportTokens,
    };
  }

  /**
   * Asynchronous registration. Each call registers one dataSource's
   * adapter (resolved asynchronously via `useFactory`). Multi-DS
   * deployments call `forRootAsync` once per dataSource.
   *
   * **Per-DS DI token limitation**: per-DS tokens
   * (`getTransactionalAdapterToken(ds)`, etc.) are NOT registered
   * for `forRootAsync` calls because the dataSource identifier is
   * only known after the async factory runs, while NestJS provider
   * tokens must be declared statically. If per-DS injection matters,
   * use sync `forRoot({ adapter })` instead — build the adapter
   * configuration through your own async logic before reaching the
   * module imports.
   *
   * `forRootAsync` still works for `AdapterRegistry`-based access
   * (`@Transactional({ dataSource })`,
   * `getCurrentEntityManager(dataSource)`,
   * `manager.run({ dataSource })`) — those route through the registry,
   * which is populated by the async factory's side effect via
   * `AdapterRegistry.register(...)`.
   *
   * @example
   * ```ts
   * TransactionalModule.forRootAsync({
   *   inject: [ConfigService],
   *   useFactory: (config: ConfigService) => ({
   *     adapter: buildAdapterFromConfig(config),
   *   }),
   * });
   * ```
   */
  static forRootAsync(options: TransactionalModuleAsyncOptions): DynamicModule {
    const isFirst = !this.infrastructureRegistered;
    const id = this.asyncCounter++;
    const asyncToken = ASYNC_OPTIONS_TOKEN(id);
    const registrationToken = ASYNC_REGISTRATION_TOKEN(id);

    // forRootAsync cannot dedup at call time (dataSource name unknown
    // until factory runs). The eager-registration factory below calls
    // AdapterRegistry.register at provider-resolution time; duplicate
    // dataSources propagate as registry-level overwrites at runtime
    // rather than module-build-time errors. This is the documented
    // limitation that pushes per-DS-injection-needs to sync forRoot.

    const asyncOptionsProvider: FactoryProvider = {
      provide: asyncToken,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };

    const adapterEagerRegistrationProvider: FactoryProvider = {
      provide: registrationToken,
      useFactory: (
        opts: TransactionalModuleAsyncFactoryResult,
        registry: AdapterRegistry,
      ): true => {
        if (opts.adapter !== undefined) {
          registry.register({
            adapterName: opts.adapter.name,
            instanceName: opts.adapter.dataSourceName,
            adapter: opts.adapter,
          });
        }
        return true;
      },
      inject: [asyncToken, ADAPTER_REGISTRY],
    };

    const providers: Provider[] = [
      asyncOptionsProvider,
      adapterEagerRegistrationProvider,
    ];
    const exportTokens: InjectionToken[] = [];

    if (isFirst) {
      this.infrastructureRegistered = true;

      // forRootAsync's `AdapterRegistry` is built fresh and the
      // eager-registration factory below mutates it via
      // `register(...)`. Ordering: NestJS resolves the registry
      // factory, then the eager-registration factory whose `inject`
      // depends on it — so by the time consumers read the registry,
      // every adapter has been registered.
      providers.push({
        provide: ADAPTER_REGISTRY,
        useFactory: (): AdapterRegistry => new AdapterRegistry(),
      });
      providers.push({
        provide: AdapterRegistry,
        useExisting: ADAPTER_REGISTRY,
      });
      providers.push(TransactionManager);

      // First-call-only observers honoring (Q2 invariant). The async
      // factory may return `observers` — only the first forRootAsync's
      // observers are wired; subsequent calls' observers are ignored
      // (we cannot throw at call time because the value is only known
      // after the factory runs).
      providers.push({
        provide: TRANSACTION_OBSERVERS,
        useFactory: (opts: TransactionalModuleAsyncFactoryResult): readonly TransactionObserver[] =>
          opts.observers ? [...opts.observers] : [],
        inject: [asyncToken],
      });

      if (options.registerInterceptor !== false) {
        providers.push({
          provide: APP_INTERCEPTOR,
          useClass: TransactionalInterceptor,
        });
      }

      if (options.registerMethodsBootstrap !== false) {
        providers.push(TransactionalMethodsBootstrap);
      }

      exportTokens.push(TransactionManager, ADAPTER_REGISTRY, AdapterRegistry);
    }

    return {
      module: TransactionalModule,
      global: options.isGlobal ?? true,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers,
      exports: exportTokens,
    };
  }
}

/**
 * Per-dataSource DI providers for ADR-018's token-based access pattern.
 * Each adapter-bearing `forRoot` call registers, for the supplied
 * adapter:
 *
 * - `getTransactionalAdapterToken(ds)` — `useValue` the adapter
 *   directly. The {@link AdapterRegistry}'s population is handled by
 *   the first-call factory (which closes over the static
 *   `registrations` Map and walks every entry at resolution time);
 *   per-DS adapter providers therefore do NOT need to inject the
 *   registry — they would not see it across multi-call DI scopes
 *   without `isGlobal: true`.
 * - `getTransactionContextToken(ds)` — a {@link TransactionContextView}
 *   pre-bound to the dataSource. Sync — the dataSource name is known
 *   at call time.
 * - `getTransactionManagerToken(ds)` — `useExisting` alias to the
 *   class-token {@link TransactionManager}. Per-call dataSource
 *   selection still goes through `manager.run({ dataSource })`; this
 *   token exists for symmetry with `@nestjs/typeorm`'s per-dataSource
 *   injection pattern (DD-022).
 *
 * `useExisting: TransactionManager` here works without cross-module
 * import because each DynamicModule with `module: TransactionalModule`
 * shares a class-token resolution within the parent module's DI tree
 * once at least one of them registers the class. For consumer modules
 * to reach `TransactionManager` and `AdapterRegistry`, set
 * `isGlobal: true` on the first `forRoot` call (the typical pattern).
 */
function buildPerDataSourceProviders(adapter: TransactionAdapter): Provider[] {
  const ds = adapter.dataSourceName;
  return [
    {
      provide: getTransactionalAdapterToken(ds),
      useValue: adapter,
    },
    {
      provide: getTransactionContextToken(ds),
      useValue: new TransactionContextView(ds),
    },
    {
      provide: getTransactionManagerToken(ds),
      useExisting: TransactionManager,
    },
  ];
}

/**
 * Build a fresh {@link AdapterRegistry} populated from the static
 * `registrations` Map on {@link TransactionalModule}. Called by the
 * first-`forRoot`'s `ADAPTER_REGISTRY` factory at provider-resolution
 * time — by then every synchronous `forRoot` body has populated the
 * Map. Pattern mirrors Phase 14.3.2 `OutboxModule` per ADR-019.
 *
 * @internal
 */
function buildRegistryFromStaticStorage(
  moduleClass: typeof TransactionalModule,
): AdapterRegistry {
  const registry = new AdapterRegistry();
  // The Map is `private static` — read it through a structural cast.
  const registrations = (
    moduleClass as unknown as { registrations: Map<string, AdapterRegistration> }
  ).registrations;
  for (const reg of registrations.values()) {
    registry.register(reg);
  }
  return registry;
}

function buildPerDataSourceExports(ds: string): InjectionToken[] {
  return [
    getTransactionalAdapterToken(ds),
    getTransactionContextToken(ds),
    getTransactionManagerToken(ds),
  ];
}
