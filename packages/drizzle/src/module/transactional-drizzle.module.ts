import {
  type DynamicModule,
  type FactoryProvider,
  Inject,
  Injectable,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OnModuleInit,
  type Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ADAPTER_REGISTRY,
  AdapterRegistry,
  getTransactionalAdapterToken,
} from '@nestjs-transactional/core';

import { DrizzleTransactionAdapter } from '../adapter/drizzle.adapter.js';
import {
  patchDrizzleInstance,
  resetDrizzlePatchingForTesting,
} from '../patching/drizzle-instance-patch.js';
import type { DrizzleDatabaseLike } from '../types/drizzle-transaction-handle.js';

export interface TransactionalDrizzleOptions {
  /**
   * The injection token your `drizzle()` database is registered under.
   * Drizzle has no Nest module of its own, so the application provides
   * the database, and this module patches that same instance: every
   * `@Inject(token)` in the application then follows `@Transactional`.
   */
  readonly db: InjectionToken;

  /**
   * The dataSource name `@Transactional({ dataSource })` and the bridges
   * know this database by. Defaults to `'default'`.
   */
  readonly dataSource?: string;

  /**
   * Make this the dataSource a `@Transactional()` without a `dataSource`
   * uses. The first adapter registered is the default otherwise.
   */
  readonly isDefault?: boolean;
}

export interface TransactionalDrizzleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly useFactory: (
    ...args: never[]
  ) => Promise<TransactionalDrizzleOptions> | TransactionalDrizzleOptions;
  readonly inject?: readonly InjectionToken[];
}

const ASYNC_OPTIONS_TOKEN = (id: number): symbol =>
  Symbol(`TRANSACTIONAL_DRIZZLE_ASYNC_OPTIONS[${id}]`);

/**
 * Registers a Drizzle ORM PostgreSQL database with `@Transactional`.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     DatabaseModule, // provides DB: drizzle(pool, { schema })
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TransactionalDrizzleModule.forRoot({ db: DB }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * Inside a `@Transactional()` method, the database injected with
 * `@Inject(DB)` runs every call on the transaction; outside, it behaves
 * as before. Import it once per database, with a `dataSource` name for
 * all but one.
 */
@Module({})
export class TransactionalDrizzleModule {
  private static asyncCounter = 0;

  /** Forgets the managed databases. Call between test cases. */
  static resetForTesting(): void {
    resetDrizzlePatchingForTesting();
    this.asyncCounter = 0;
  }

  static forRoot(options: TransactionalDrizzleOptions): DynamicModule {
    const dataSourceName = options.dataSource ?? 'default';
    const adapterToken = getTransactionalAdapterToken(dataSourceName);

    const adapterProvider: FactoryProvider = {
      provide: adapterToken,
      useFactory: (db: DrizzleDatabaseLike, registry: AdapterRegistry): DrizzleTransactionAdapter =>
        registerManagedDatabase({
          db,
          dataSourceName,
          isDefault: options.isDefault ?? false,
          registry,
        }),
      inject: [options.db, ADAPTER_REGISTRY],
    };

    return {
      module: TransactionalDrizzleModule,
      providers: [adapterProvider],
      exports: [adapterToken],
    };
  }

  /**
   * `forRoot` with options resolved at bootstrap. The database token
   * comes out of the factory, so the database is looked up in
   * `onModuleInit`, once every provider exists, as
   * `TransactionalTypeOrmModule.forRootAsync` does.
   */
  static forRootAsync(options: TransactionalDrizzleAsyncOptions): DynamicModule {
    const id = this.asyncCounter++;
    const asyncToken = ASYNC_OPTIONS_TOKEN(id);

    const asyncOptionsProvider: FactoryProvider = {
      provide: asyncToken,
      useFactory: options.useFactory,
      inject: options.inject ? [...options.inject] : undefined,
    };
    const RegistrationCls = createAsyncRegistrationClass(id, asyncToken);

    return {
      module: TransactionalDrizzleModule,
      imports: options.imports ?? [],
      providers: [asyncOptionsProvider, RegistrationCls],
      exports: [RegistrationCls],
    };
  }
}

function createAsyncRegistrationClass(id: number, asyncToken: symbol): Type<OnModuleInit> {
  @Injectable()
  class TransactionalDrizzleAsyncRegistration implements OnModuleInit {
    constructor(
      @Inject(asyncToken)
      private readonly resolved: TransactionalDrizzleOptions,
      @Inject(ADAPTER_REGISTRY)
      private readonly registry: AdapterRegistry,
      private readonly moduleRef: ModuleRef,
    ) {}

    onModuleInit(): void {
      registerManagedDatabase({
        db: this.moduleRef.get<DrizzleDatabaseLike>(this.resolved.db, { strict: false }),
        dataSourceName: this.resolved.dataSource ?? 'default',
        isDefault: this.resolved.isDefault ?? false,
        registry: this.registry,
      });
    }
  }
  Object.defineProperty(TransactionalDrizzleAsyncRegistration, 'name', {
    value: `TransactionalDrizzleAsyncRegistration_${id}`,
  });
  return TransactionalDrizzleAsyncRegistration;
}

function registerManagedDatabase(args: {
  readonly db: DrizzleDatabaseLike;
  readonly dataSourceName: string;
  readonly isDefault: boolean;
  readonly registry: AdapterRegistry;
}): DrizzleTransactionAdapter {
  const { db, dataSourceName, isDefault, registry } = args;
  // The adapter checks the database first, so a wrong one is refused
  // before anything is patched.
  const adapter = new DrizzleTransactionAdapter(db, dataSourceName);
  patchDrizzleInstance(db, dataSourceName);
  registry.register({ adapterName: 'drizzle', instanceName: dataSourceName, adapter }, isDefault);
  return adapter;
}
