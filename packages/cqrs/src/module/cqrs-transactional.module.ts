import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { CqrsModule, EventBus, EventPublisher } from '@nestjs/cqrs';
import { TransactionManager } from '@nestjs-transactional/core';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher';
import { HybridEventPublisher } from '../event-publisher/hybrid-event-publisher';
import { TransactionalEventPublisher } from '../event-publisher/transactional-event-publisher';
import { TransactionalEventPublisherAdapter } from '../event-publisher/transactional-event-publisher-adapter';
import { ApplicationModuleHandlerScanner } from '../handlers/application-module-handler-scanner';
import { CqrsTransactionalBootstrap } from '../handlers/bootstrap';
import { CqrsHandlerWrapper, type HandlerWrapperOptions } from '../handlers/handler-wrapper';
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
 * - `defaultQueryOptions`: `{ readOnly: true }`
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
 * NestJS module that wires the `@nestjs-transactional/cqrs` runtime:
 *
 * - {@link TransactionalEventDispatcher} for phase-aware event
 *   routing.
 * - {@link TransactionalListenerScanner} for auto-registration of
 *   `@TransactionalEventsHandler`-decorated classes at module init.
 * - {@link ApplicationModuleHandlerScanner} for
 *   `@ApplicationModuleHandler`-decorated classes, with smart routing
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
 * application root. For TypeORM-backed applications, also register
 * adapters with `TypeOrmTransactionalModule.forFeature(...)`.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TypeOrmTransactionalModule.forFeature({ dataSource: myDs }),
 *     CqrsModule,
 *     CqrsTransactionalModule.forRoot(),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class CqrsTransactionalModule {
  static forRoot(options: CqrsTransactionalOptions = {}): DynamicModule {
    const resolved: Required<
      Pick<
        CqrsTransactionalOptions,
        | 'wrapCommandHandlers'
        | 'wrapQueryHandlers'
        | 'wrapEventHandlers'
        | 'useTransactionalEventPublisher'
      >
    > &
      Pick<CqrsTransactionalOptions, 'defaultQueryOptions' | 'defaultCommandOptions'> = {
      wrapCommandHandlers: options.wrapCommandHandlers ?? true,
      wrapQueryHandlers: options.wrapQueryHandlers ?? true,
      wrapEventHandlers: options.wrapEventHandlers ?? true,
      useTransactionalEventPublisher: options.useTransactionalEventPublisher ?? true,
      defaultQueryOptions: options.defaultQueryOptions ?? { readOnly: true },
      defaultCommandOptions: options.defaultCommandOptions,
    };

    const providers: Provider[] = [
      {
        provide: CQRS_TRANSACTIONAL_OPTIONS,
        useValue: resolved,
      },
      TransactionalEventDispatcher,
      TransactionalListenerScanner,
      ApplicationModuleHandlerScanner,
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

    const exportTokens: unknown[] = [TransactionalEventDispatcher];

    if (resolved.useTransactionalEventPublisher) {
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
      imports: [DiscoveryModule, CqrsModule],
      providers,
      exports: exportTokens as never[],
    };
  }
}
