import {
  type DynamicModule,
  type FactoryProvider,
  Inject,
  Injectable,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OnModuleInit,
  type Provider,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  ADAPTER_REGISTRY,
  AdapterRegistry,
  getTransactionalAdapterToken,
} from '@nestjs-transactional/core';
import type { DataSource } from 'typeorm';

import { TypeOrmTransactionAdapter } from '../adapter/typeorm.adapter';
import {
  applyAllPatches,
  markAsManaged,
  patchDataSourceInstance,
  resetPatchingForTesting,
} from '../patching';

// ---------------------------------------------------------------
// Apply Repository / EntityManager prototype patches at MODULE-LOAD
// time, NOT at `forRoot` factory time.
//
// Why module-load: NestJS resolves providers in dependency order
// during `compile()`. A `useFactory` provider that calls
// `dataSource.getRepository(Entity)` (e.g. `@InjectRepository`'s
// internal factory) runs BEFORE `TypeOrmTransactionalModule.forRoot`'s
// factory if it has no DI dependency on the latter. A Repository
// constructed before the patches are installed gets its
// `this.manager = manager` assignment as an own-property, which
// permanently shadows the prototype getter — that Repository
// instance can never dispatch through the active transactional
// EntityManager.
//
// Installing the patches as a side effect of importing this file
// guarantees they're in place before any DI factory could ever
// observe an unpatched `Repository.prototype`. Idempotent: a second
// import (e.g. a stale duplicate copy on disk under pnpm hoist
// glitches) is a no-op via the install-once flag inside each patch.
// ---------------------------------------------------------------
applyAllPatches();

/**
 * Options accepted by {@link TypeOrmTransactionalModule.forRoot}.
 *
 * Phase 14.20 reshape: this module now resolves the actual TypeORM
 * `DataSource` via DI (using `getDataSourceToken` from
 * `@nestjs/typeorm`) instead of taking it as a constructor argument.
 * The new contract is "TypeORM is configured by `@nestjs/typeorm`'s
 * `TypeOrmModule.forRoot(...)`; we just bind to it by name."
 */
export interface TypeOrmTransactionalOptions {
  /**
   * DataSource name as used by `@nestjs/typeorm`'s
   * `TypeOrmModule.forRoot({ name })`. Defaults to `'default'`. The
   * actual `DataSource` instance is resolved from DI under
   * `getDataSourceToken(this.dataSource)`.
   */
  readonly dataSource?: string;

  /**
   * Mark this adapter as the registry-level default. Affects
   * `@Transactional()` calls that omit the `dataSource` option.
   * Defaults to `false`; the first registered adapter becomes the
   * default automatically (per {@link AdapterRegistry.register}).
   */
  readonly isDefault?: boolean;
}

/**
 * Asynchronous flavour of {@link TypeOrmTransactionalOptions}.
 *
 * **Per-DS DI token limitation**: the per-dataSource adapter token
 * (`getTransactionalAdapterToken(ds)`) is NOT registered for
 * `forRootAsync` because the dataSource name is only known after
 * the async factory runs, while NestJS provider tokens must be
 * declared statically. If per-DS injection of the adapter matters,
 * use sync `forRoot({ dataSource })` instead. The
 * `AdapterRegistry`-based access path
 * (`@Transactional({ dataSource })`,
 * `getCurrentEntityManager(dataSource)`,
 * `manager.run({ dataSource })`) is unaffected — those route
 * through the registry, which the eager-registration factory
 * populates as a side effect.
 *
 * Mirrors the documented limitation on
 * `TransactionalModule.forRootAsync` (Phase 14.10).
 */
export interface TypeOrmTransactionalAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly useFactory: (
    ...args: never[]
  ) => Promise<TypeOrmTransactionalOptions> | TypeOrmTransactionalOptions;
  readonly inject?: readonly InjectionToken[];
}

const ASYNC_OPTIONS_TOKEN = (id: number): symbol =>
  Symbol(`TYPEORM_TRANSACTIONAL_ASYNC_OPTIONS[${id}]`);

/**
 * NestJS module that binds a TypeORM {@link DataSource} to the core
 * {@link AdapterRegistry} as a transactional adapter AND activates
 * the transparent transactional patching machinery (Phase 14.20).
 * Once registered:
 *
 * - Every `Repository` reachable via `@InjectRepository`,
 *   `dataSource.getRepository(...)`, `entityManager.getRepository(...)`,
 *   or `repo.extend(...)` automatically dispatches inside the active
 *   `@Transactional()` scope.
 * - `dataSource.query(...)` and `dataSource.createQueryBuilder(...)`
 *   pick up the transactional `QueryRunner`.
 * - `@InjectEntityManager() em.getRepository(E).save(...)` works
 *   transactionally (the wrapped `EntityManager.prototype.getRepository`
 *   stamps the manager reference). Direct
 *   `@InjectEntityManager() em.save(E, ...)` is a documented
 *   limitation — use the Repository pattern or
 *   `getCurrentEntityManager()` as escape hatch.
 *
 * Multi-dataSource deployments call {@link forRoot} once per
 * dataSource (mirrors `OutboxModule` per ADR-019 and
 * `TransactionalModule` per ADR-018):
 *
 * ```ts
 * @Module({
 *   imports: [
 *     TypeOrmModule.forRoot({ type: 'postgres', ... }),
 *     TypeOrmModule.forRoot({ type: 'postgres', name: 'billing', ... }),
 *
 *     TransactionalModule.forRoot({}),                           // infra
 *     TypeOrmTransactionalModule.forRoot(),                      // default
 *     TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Patches are applied process-wide on the first `forRoot`/`forRootAsync`
 * call (idempotent on re-entry). DataSource instances are tracked in
 * a `WeakSet`; non-managed DataSources are never touched by the
 * patches — they continue to behave as TypeORM does normally.
 */
@Module({})
export class TypeOrmTransactionalModule {
  /**
   * @internal
   * Counter for `forRootAsync`-only token uniqueness. Mirrors the
   * pattern used in `TransactionalModule.forRootAsync` — every
   * async call gets a unique provider symbol so consecutive calls
   * don't collide.
   */
  private static asyncCounter = 0;

  /**
   * Test-only — drop the managed-DataSources `WeakSet` so cached
   * repositories from a prior test fall through to their original
   * (autocommit) manager. Prototype-level patches are NOT removed;
   * they were installed once-and-stay, by design (see
   * `repository-patches.ts` JSDoc). Per-instance `DataSource`
   * patches survive on those `DataSource` instances — tests that
   * destroy and recreate the `DataSource` between cases (the
   * typical pattern) are unaffected.
   *
   * Re-registering the SAME `DataSource` after a reset is safe:
   * `patchDataSourceInstance` is idempotent via a marker symbol,
   * and `markAsManaged` re-stamps the same name harmlessly.
   *
   * Production code should never call this.
   *
   * @internal
   */
  static resetForTesting(): void {
    resetPatchingForTesting();
    this.asyncCounter = 0;
  }

  /**
   * Synchronous registration. Each call binds one DataSource (by
   * name) to the transactional infrastructure. Patches are
   * activated idempotently on the first call.
   *
   * @example Default DataSource
   * ```ts
   * TypeOrmTransactionalModule.forRoot()
   * ```
   *
   * @example Named DataSource
   * ```ts
   * TypeOrmTransactionalModule.forRoot({ dataSource: 'billing' })
   * ```
   */
  static forRoot(options: TypeOrmTransactionalOptions = {}): DynamicModule {
    const dataSourceName = options.dataSource ?? 'default';
    const dataSourceToken = getDataSourceToken(dataSourceName);
    const adapterToken = getTransactionalAdapterToken(dataSourceName);

    const adapterProvider: FactoryProvider = {
      provide: adapterToken,
      useFactory: (ds: DataSource, registry: AdapterRegistry): TypeOrmTransactionAdapter =>
        registerManagedDataSource({
          dataSource: ds,
          dataSourceName,
          isDefault: options.isDefault ?? false,
          registry,
        }),
      inject: [dataSourceToken, ADAPTER_REGISTRY],
    };

    return {
      module: TypeOrmTransactionalModule,
      providers: [adapterProvider],
      exports: [adapterToken],
    };
  }

  /**
   * Asynchronous registration. Resolves
   * {@link TypeOrmTransactionalOptions} via a NestJS-style async
   * factory before binding the adapter. See
   * {@link TypeOrmTransactionalAsyncOptions} for the per-DS-token
   * limitation.
   *
   * @example
   * ```ts
   * TypeOrmTransactionalModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => ({
   *     dataSource: cfg.get('DATA_SOURCE_NAME'),
   *     isDefault: true,
   *   }),
   * });
   * ```
   */
  static forRootAsync(options: TypeOrmTransactionalAsyncOptions): DynamicModule {
    const id = this.asyncCounter++;
    const asyncToken = ASYNC_OPTIONS_TOKEN(id);

    const asyncOptionsProvider: FactoryProvider = {
      provide: asyncToken,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };

    // The DataSource token depends on the async-resolved name, so
    // we cannot put `getDataSourceToken(...)` into the registration
    // provider's `inject` array statically. We also cannot resolve
    // it inside a `useFactory` provider via `ModuleRef` — at the
    // time `useFactory` providers run, NestJS has not yet
    // initialised siblings whose DI dependencies do not point at
    // them, so `@nestjs/typeorm`'s DataSource provider may still be
    // a pending Promise. The historical use of `moduleRef.resolve`
    // (or even `moduleRef.get`) cascaded into a hard-to-diagnose
    // `Invalid value used in weak set` followed by
    // `this.postgres.Pool is not a constructor` when paired with
    // `TypeOrmModule.forRootAsync` (Phase 14.8e Convention #22).
    //
    // The robust pattern is `OnModuleInit`: by the time the hook
    // runs, every provider in the module tree has been instantiated
    // (including async DataSource factories from `@nestjs/typeorm`).
    // `moduleRef.get(...)` then returns the real DataSource
    // instance, and `registerManagedDataSource` succeeds.
    const RegistrationCls = createAsyncRegistrationClass(id, asyncToken);

    const providers: Provider[] = [asyncOptionsProvider, RegistrationCls];

    return {
      module: TypeOrmTransactionalModule,
      imports: options.imports ?? [],
      providers,
      // Nothing exports `registrationToken` for this path — the
      // service runs side-effect-only via OnModuleInit. Export
      // the registration class so consumers wanting explicit
      // ordering can depend on it being initialised.
      exports: [RegistrationCls],
    };
  }
}

/**
 * Generate a unique `OnModuleInit` registration class per
 * `forRootAsync` call. The class injects the async-resolved
 * `TypeOrmTransactionalOptions`, the global `AdapterRegistry`, and
 * `ModuleRef`. In `onModuleInit()` it resolves the actual
 * `DataSource` (every DI provider is ready by then) and calls
 * {@link registerManagedDataSource}.
 *
 * Uniqueness per `id` matters because each `forRootAsync` call
 * registers its OWN provider class — multiple async registrations
 * in the same app must not collide on the same constructor token.
 *
 * Module-level `Reflect` metadata required by NestJS DI is set up
 * via `@Inject(asyncToken)` on the constructor parameter.
 */
function createAsyncRegistrationClass(
  id: number,
  asyncToken: symbol,
): Type<OnModuleInit> {
  @Injectable()
  class TypeOrmTransactionalAsyncRegistration implements OnModuleInit {
    constructor(
      @Inject(asyncToken)
      private readonly resolved: TypeOrmTransactionalOptions,
      @Inject(ADAPTER_REGISTRY)
      private readonly registry: AdapterRegistry,
      private readonly moduleRef: ModuleRef,
    ) {}

    onModuleInit(): void {
      const dataSourceName = this.resolved.dataSource ?? 'default';
      const dataSourceToken = getDataSourceToken(dataSourceName);
      const ds = this.moduleRef.get<DataSource>(dataSourceToken, {
        strict: false,
      });
      registerManagedDataSource({
        dataSource: ds,
        dataSourceName,
        isDefault: this.resolved.isDefault ?? false,
        registry: this.registry,
      });
    }
  }
  // Distinguish each generated class so a TypeScript reflection /
  // logging consumer can tell them apart. Class identity itself is
  // already unique per call (each `class` expression yields a fresh
  // constructor), but a meaningful `name` helps with stack traces.
  Object.defineProperty(TypeOrmTransactionalAsyncRegistration, 'name', {
    value: `TypeOrmTransactionalAsyncRegistration_${id}`,
  });
  return TypeOrmTransactionalAsyncRegistration;
}

/**
 * Common registration path used by both `forRoot`'s factory
 * provider and the `forRootAsync` `OnModuleInit` registration
 * class. Centralises the four-step dance of patch-on-first-use,
 * mark-as-managed, instance-patch, and register-with-AdapterRegistry
 * so the two entry points cannot drift out of step.
 */
function registerManagedDataSource(args: {
  readonly dataSource: DataSource;
  readonly dataSourceName: string;
  readonly isDefault: boolean;
  readonly registry: AdapterRegistry;
}): TypeOrmTransactionAdapter {
  const { dataSource, dataSourceName, isDefault, registry } = args;
  applyAllPatches();
  markAsManaged(dataSource, dataSourceName);
  patchDataSourceInstance(dataSource);

  const adapter = new TypeOrmTransactionAdapter(dataSource, dataSourceName);
  registry.register(
    { adapterName: 'typeorm', instanceName: dataSourceName, adapter },
    isDefault,
  );
  return adapter;
}
