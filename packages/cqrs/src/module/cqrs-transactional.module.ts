import {
  type DynamicModule,
  type FactoryProvider,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { CqrsModule, EventBus, EventPublisher } from '@nestjs/cqrs';
import { TransactionManager } from '@nestjs-transactional/core';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';
import { HybridEventPublisher } from '../event-publisher/hybrid-event-publisher';
import { TransactionalEventPublisher } from '../event-publisher/transactional-event-publisher';
import { TransactionalEventPublisherAdapter } from '../event-publisher/transactional-event-publisher-adapter';
import { CqrsTransactionalBootstrap } from '../handlers/bootstrap';
import { CqrsHandlerWrapper, type HandlerWrapperOptions } from '../handlers/handler-wrapper';
import { IntegrationEventsHandlerScanner } from '../handlers/integration-events-handler-scanner';
import { TransactionalListenerScanner } from '../handlers/listener-scanner';

/**
 * DI token for the resolved {@link CqrsTransactionalOptions} object.
 * Consumers normally do not inject this directly — it is used by the
 * module's internal factory to pass options to {@link CqrsHandlerWrapper}.
 */
export const CQRS_TRANSACTIONAL_OPTIONS = 'CQRS_TRANSACTIONAL_OPTIONS';

/**
 * Options accepted by {@link CqrsTransactionalModule.forRoot}. Extends
 * {@link HandlerWrapperOptions} with the flag controlling whether
 * `@nestjs/cqrs`'s `EventPublisher` is overridden with
 * {@link TransactionalEventPublisherAdapter}.
 *
 * Defaults:
 * - `wrapCommandHandlers`: `true`
 * - `wrapQueryHandlers`: `true`
 * - `wrapEventHandlers`: `true`
 * - `defaultQueryOptions`: `{ readOnly: true }` — enforced by the
 *   database on Postgres-family dialects, a documenting hint elsewhere
 *   (DD-027)
 * - `useTransactionalEventPublisher`: `true`
 */
export interface CqrsTransactionalOptions extends HandlerWrapperOptions {
  /**
   * If `true` (default), overrides `@nestjs/cqrs`'s `EventPublisher`
   * DI token with {@link TransactionalEventPublisherAdapter} so
   * `AggregateRoot.commit()` routes events through the transactional
   * dispatcher (phase-aware handlers). Set to `false` to leave the
   * standard `EventPublisher` in place — useful when integrating
   * progressively into an existing codebase.
   */
  readonly useTransactionalEventPublisher?: boolean;
}

/**
 * Result shape resolved by {@link CqrsTransactionalAsyncOptions.useFactory}.
 *
 * Carries only the value-shaped options — the ones
 * {@link CqrsHandlerWrapper} reads at runtime.
 * `useTransactionalEventPublisher` is deliberately NOT here: it decides
 * whether the `EventPublisher` override provider exists at all, and
 * NestJS needs provider tokens at module-definition time, before any
 * async factory has run. It lives on
 * {@link CqrsTransactionalAsyncOptions} instead — the same split
 * `OutboxModule.forRootAsync` uses for `repository` (convention #21).
 */
export type CqrsTransactionalAsyncFactoryResult = HandlerWrapperOptions;

/**
 * Asynchronous options for {@link CqrsTransactionalModule.forRootAsync}.
 *
 * There is still exactly one `CqrsTransactionalModule` registration per
 * application regardless of how many dataSources are configured — the
 * cqrs runtime is dataSource-agnostic by design, so unlike
 * `OutboxModule` there is no per-dataSource variant of this call.
 */
export interface CqrsTransactionalAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  /**
   * Structural — see {@link CqrsTransactionalAsyncFactoryResult}. Same
   * meaning and default (`true`) as on
   * {@link CqrsTransactionalOptions}.
   */
  readonly useTransactionalEventPublisher?: boolean;
  readonly useFactory: (
    ...args: never[]
  ) => Promise<CqrsTransactionalAsyncFactoryResult> | CqrsTransactionalAsyncFactoryResult;
  readonly inject?: readonly InjectionToken[];
}

/** Resolved wrapper options, with `forRoot`'s defaults applied. */
type ResolvedWrapperOptions = Required<
  Pick<HandlerWrapperOptions, 'wrapCommandHandlers' | 'wrapQueryHandlers' | 'wrapEventHandlers'>
> &
  Pick<HandlerWrapperOptions, 'defaultQueryOptions' | 'defaultCommandOptions'>;

/**
 * Single source of truth for the option defaults, so `forRoot` and
 * `forRootAsync` cannot drift apart.
 */
function resolveWrapperOptions(options: HandlerWrapperOptions): ResolvedWrapperOptions {
  return {
    wrapCommandHandlers: options.wrapCommandHandlers ?? true,
    wrapQueryHandlers: options.wrapQueryHandlers ?? true,
    wrapEventHandlers: options.wrapEventHandlers ?? true,
    defaultQueryOptions: options.defaultQueryOptions ?? { readOnly: true },
    defaultCommandOptions: options.defaultCommandOptions,
  };
}

/**
 * NestJS module that wires the `@nestjs-transactional/cqrs` runtime:
 *
 * - {@link TransactionalEventDispatcher} for phase-aware event
 *   routing.
 * - {@link TransactionalListenerScanner} for auto-registration of
 *   `@TransactionalEventsHandler`-decorated classes at module init.
 * - {@link IntegrationEventsHandlerScanner} for
 *   `@IntegrationEventsHandler`-decorated classes, with smart routing
 *   to the outbox (when bound) or the dispatcher (otherwise).
 * - {@link CqrsHandlerWrapper} + {@link CqrsTransactionalBootstrap}
 *   to wrap `@CommandHandler` / `@QueryHandler` / `@EventsHandler`
 *   execute/handle methods at application bootstrap.
 * - {@link TransactionalEventPublisher} +
 *   {@link TransactionalEventPublisherAdapter} as the `EventPublisher`
 *   DI override so `AggregateRoot.commit()` flows through the
 *   dispatcher.
 *
 * Pair with `TransactionalModule.forRoot({ isGlobal: true })` at the
 * application root. For TypeORM-backed applications, register one
 * adapter per DataSource with `TypeOrmTransactionalModule.forRoot(...)`
 * (ADR-019 — one call per dataSource, not one per feature module).
 *
 * Do NOT import `@nestjs/cqrs`'s `CqrsModule` alongside this module
 * (convention #6): this module imports `CqrsModule` internally and
 * overrides the `EventPublisher` DI token, so a second import in the
 * consumer shadows the override and aggregate events silently bypass
 * the dispatcher.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forRoot({ isDefault: true }),
 *     // No `CqrsModule` here — see the note above.
 *     CqrsTransactionalModule.forRoot(),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * **Multi-dataSource setups**: the cqrs runtime is
 * dataSource-agnostic by design. There is exactly one
 * `CqrsTransactionalModule.forRoot()` per application regardless of
 * how many dataSources are configured — multi-DS routing emerges
 * from the structural-port wiring, not from a per-DS module instance.
 *
 * Wire {@link OUTBOX_PUBLICATION_SCHEDULER} and
 * {@link OUTBOX_LISTENER_REGISTRAR} to the outbox stack you want
 * cqrs to delegate to (`useExisting: OutboxEventPublisher` /
 * `useExisting: OutboxListenerRegistry`). Apps with multiple outbox
 * stacks (one `OutboxModule.forRoot()` per dataSource — ADR-019)
 * choose which one cqrs bridges to via the `useExisting` target.
 *
 * Known limitation in multi-DS deployments: the in-memory
 * dispatcher's hook-attachment goes through
 * `TransactionManager.registerBeforeCommit` / `registerAfterCommit`,
 * which target the first-active transaction on the current async
 * context (non-deterministic across simultaneously-active
 * cross-dataSource transactions). For cross-DS event handling
 * prefer the outbox path — see `docs/known-limitations.md`.
 */
@Module({})
export class CqrsTransactionalModule {
  static forRoot(options: CqrsTransactionalOptions = {}): DynamicModule {
    return buildModule({
      optionsProvider: {
        provide: CQRS_TRANSACTIONAL_OPTIONS,
        useValue: resolveWrapperOptions(options),
      },
      useTransactionalEventPublisher: options.useTransactionalEventPublisher ?? true,
    });
  }

  /**
   * Asynchronous registration. Resolves the wrapper options through a
   * NestJS-style async factory before binding
   * {@link CqrsHandlerWrapper}.
   *
   * @example
   * ```ts
   * CqrsTransactionalModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => ({
   *     wrapQueryHandlers: cfg.get('WRAP_QUERIES') !== 'false',
   *     defaultCommandOptions: { isolation: cfg.get('TX_ISOLATION') },
   *   }),
   * });
   * ```
   */
  static forRootAsync(options: CqrsTransactionalAsyncOptions): DynamicModule {
    const optionsProvider: FactoryProvider = {
      provide: CQRS_TRANSACTIONAL_OPTIONS,
      useFactory: async (
        ...args: never[]
      ): Promise<ResolvedWrapperOptions> =>
        resolveWrapperOptions(await options.useFactory(...args)),
      inject: options.inject ? [...options.inject] : undefined,
    };

    return buildModule({
      optionsProvider,
      useTransactionalEventPublisher: options.useTransactionalEventPublisher ?? true,
      imports: options.imports,
    });
  }
}

/**
 * Shared module shape for both registration paths. The only difference
 * between them is how {@link CQRS_TRANSACTIONAL_OPTIONS} is provided —
 * everything downstream injects that token, so the provider matrix is
 * identical.
 */
function buildModule(args: {
  optionsProvider: Provider;
  useTransactionalEventPublisher: boolean;
  imports?: ModuleMetadata['imports'];
}): DynamicModule {
  const providers: Provider[] = [
    args.optionsProvider,
    TransactionalEventDispatcher,
    TransactionalListenerScanner,
    IntegrationEventsHandlerScanner,
    {
      provide: CqrsHandlerWrapper,
      useFactory: (
        discovery: DiscoveryService,
        manager: TransactionManager,
        opts: HandlerWrapperOptions,
      ): CqrsHandlerWrapper => new CqrsHandlerWrapper(discovery, manager, opts),
      inject: [DiscoveryService, TransactionManager, CQRS_TRANSACTIONAL_OPTIONS],
    },
    CqrsTransactionalBootstrap,
  ];

  // NOT named `exports`: in the CommonJS output that shadows the
  // module-level `exports` object, and the TDZ of the local const
  // breaks every earlier `exports.X = ...` assignment in this file.
  const exportTokens: InjectionToken[] = [TransactionalEventDispatcher];

  if (args.useTransactionalEventPublisher) {
    // Keep TransactionalEventPublisher as a standalone provider for
    // consumers that want the in-memory-only strategy. The adapter
    // itself now routes through HybridEventPublisher, which picks
    // up the optional outbox scheduler via @Optional injection.
    providers.push(TransactionalEventPublisher);
    providers.push(HybridEventPublisher);
    providers.push({
      provide: EventPublisher,
      useFactory: (
        strategy: HybridEventPublisher,
        eventBus: EventBus,
      ): TransactionalEventPublisherAdapter =>
        new TransactionalEventPublisherAdapter(strategy, eventBus),
      inject: [HybridEventPublisher, EventBus],
    });
    exportTokens.push(TransactionalEventPublisher, HybridEventPublisher, EventPublisher);
  }

  return {
    module: CqrsTransactionalModule,
    imports: [DiscoveryModule, CqrsModule, ...(args.imports ?? [])],
    providers,
    exports: exportTokens,
  };
}
