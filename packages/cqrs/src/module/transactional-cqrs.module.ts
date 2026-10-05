import {
  type DynamicModule,
  type FactoryProvider,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { CqrsModule, type CqrsModuleOptions, type IEventPublisher } from '@nestjs/cqrs';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher.js';
import { CqrsEventBusBinding } from '../event-publisher/event-bus-binding.js';
import { TransactionalEventBusPublisher } from '../event-publisher/transactional-event-bus-publisher.js';
import { TransactionalCqrsBootstrap } from '../handlers/bootstrap.js';
import {
  CQRS_HANDLER_WRAPPER_OPTIONS,
  CqrsHandlerWrapper,
  type HandlerWrapperOptions,
} from '../handlers/handler-wrapper.js';
import { IntegrationEventsHandlerScanner } from '../handlers/integration-events-handler-scanner.js';
import { TransactionalListenerScanner } from '../handlers/listener-scanner.js';

import { TRANSACTIONAL_CQRS_OPTIONS } from './tokens.js';

export { TRANSACTIONAL_CQRS_OPTIONS };

/**
 * Options read at runtime, from `forRoot` directly or from
 * `forRootAsync`'s factory.
 *
 * Defaults:
 * - `wrapCommandHandlers`: `true`
 * - `wrapQueryHandlers`: `true`
 * - `wrapEventHandlers`: `true`
 * - `defaultQueryOptions`: `{ readOnly: true }`, enforced by the
 *   database on Postgres-family dialects, a documenting hint elsewhere
 *   (DD-027)
 * - `eventsDataSource`: `'default'`
 */
export interface TransactionalCqrsAsyncFactoryResult extends HandlerWrapperOptions {
  /**
   * The DataSource whose transaction a publish inside `@Transactional`
   * carries in its dispatcher context, as `{ transaction }`: what
   * `@nestjs/workflows`' `@StartOn` and `@SignalOn` write through.
   * Defaults to `'default'`.
   */
  readonly eventsDataSource?: string;
}

/**
 * Options that shape the module itself, so NestJS needs them when the
 * module is defined, before any async factory has run (convention #21).
 */
interface TransactionalCqrsStructuralOptions {
  /**
   * Options for `@nestjs/cqrs`'s `CqrsModule.forRoot()`, which this
   * module imports. Pass them here rather than importing `CqrsModule`
   * yourself: a second import creates a second `EventBus`.
   */
  readonly cqrs?: Omit<CqrsModuleOptions, 'eventPublisher'>;

  /**
   * Your own event publisher, the one you would otherwise pass to
   * `CqrsModule.forRoot({ eventPublisher })`. Events reach it after their
   * transaction phases and the outbox have been scheduled, in place of
   * the in-memory delivery to `@EventsHandler`s.
   */
  readonly eventPublisher?: IEventPublisher;
}

/** Options accepted by {@link TransactionalCqrsModule.forRoot}. */
export interface TransactionalCqrsOptions
  extends TransactionalCqrsAsyncFactoryResult, TransactionalCqrsStructuralOptions {}

/**
 * Asynchronous options for {@link TransactionalCqrsModule.forRootAsync}.
 *
 * There is still exactly one `TransactionalCqrsModule` registration per
 * application regardless of how many dataSources are configured: the
 * cqrs runtime is dataSource-agnostic by design.
 */
export interface TransactionalCqrsAsyncOptions
  extends Pick<ModuleMetadata, 'imports'>, TransactionalCqrsStructuralOptions {
  readonly useFactory: (
    ...args: never[]
  ) => Promise<TransactionalCqrsAsyncFactoryResult> | TransactionalCqrsAsyncFactoryResult;
  readonly inject?: readonly InjectionToken[];
}

/** Resolved runtime options, with the defaults applied. */
type ResolvedOptions = Required<
  Pick<HandlerWrapperOptions, 'wrapCommandHandlers' | 'wrapQueryHandlers' | 'wrapEventHandlers'>
> &
  Pick<HandlerWrapperOptions, 'defaultQueryOptions' | 'defaultCommandOptions'> & {
    readonly eventsDataSource: string;
  };

/**
 * Single source of truth for the option defaults, so `forRoot` and
 * `forRootAsync` cannot drift apart.
 */
function resolveOptions(options: TransactionalCqrsAsyncFactoryResult): ResolvedOptions {
  return {
    wrapCommandHandlers: options.wrapCommandHandlers ?? true,
    wrapQueryHandlers: options.wrapQueryHandlers ?? true,
    wrapEventHandlers: options.wrapEventHandlers ?? true,
    defaultQueryOptions: options.defaultQueryOptions ?? { readOnly: true },
    defaultCommandOptions: options.defaultCommandOptions,
    eventsDataSource: options.eventsDataSource ?? 'default',
  };
}

/**
 * NestJS module that wires the `@nestjs-transactional/cqrs` runtime:
 *
 * - `@nestjs/cqrs`'s `CqrsModule.forRoot()`, with
 *   {@link TransactionalEventBusPublisher} as the `EventBus`'s publisher,
 *   so every event the bus publishes, from `AggregateRoot.commit()` or
 *   `eventBus.publish()`, schedules its phase handlers and, when wired,
 *   the outbox, then reaches `@EventsHandler`s and sagas at once
 *   (ADR-024, DD-029);
 * - {@link CqrsEventBusBinding}, which puts `{ transaction }` into the
 *   dispatcher context of a publish inside `@Transactional`, so a
 *   publisher that wraps the bus (`@nestjs/workflows`'
 *   `WorkflowsCqrsModule`) writes in that transaction;
 * - {@link TransactionalEventDispatcher} and the scanners for
 *   `@TransactionalEventsHandler` and `@IntegrationEventsHandler`;
 * - {@link CqrsHandlerWrapper} and {@link TransactionalCqrsBootstrap},
 *   which run `@CommandHandler`, `@QueryHandler` and `@EventsHandler`
 *   methods in a transaction.
 *
 * Pair with `TransactionalModule.forRoot({ isGlobal: true })` at the
 * application root, and one `TransactionalTypeOrmModule.forRoot(...)` per
 * DataSource (ADR-019).
 *
 * Do NOT import `@nestjs/cqrs`'s `CqrsModule` alongside this module
 * (convention #6): this module imports `CqrsModule.forRoot()` itself, and
 * a second import creates a second `EventBus` that bypasses the
 * transactional publisher. Pass `CqrsModule` options as `cqrs`, and your
 * own event publisher as `eventPublisher`. Bootstrap fails if a second
 * `EventBus` exists or the publisher was replaced.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TransactionalTypeOrmModule.forRoot({ isDefault: true }),
 *     // No `CqrsModule` here: see the note above.
 *     TransactionalCqrsModule.forRoot(),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * The outbox side is wired by `@nestjs-transactional/outbox`'s
 * `TransactionalOutboxModule.forRoot()`, which binds
 * `OUTBOX_PUBLICATION_SCHEDULER`. Nothing to declare here.
 */
@Module({})
export class TransactionalCqrsModule {
  static forRoot(options: TransactionalCqrsOptions = {}): DynamicModule {
    return buildModule({
      optionsProvider: { provide: TRANSACTIONAL_CQRS_OPTIONS, useValue: resolveOptions(options) },
      structural: options,
    });
  }

  /**
   * Asynchronous registration. Resolves the runtime options through a
   * NestJS-style async factory. `cqrs` and `eventPublisher` shape the
   * module, so they are passed statically, beside the factory.
   *
   * @example
   * ```ts
   * TransactionalCqrsModule.forRootAsync({
   *   imports: [ConfigModule],
   *   inject: [ConfigService],
   *   useFactory: (cfg: ConfigService) => ({
   *     wrapQueryHandlers: cfg.get('WRAP_QUERIES') !== 'false',
   *     defaultCommandOptions: { isolation: cfg.get('TX_ISOLATION') },
   *   }),
   * });
   * ```
   */
  static forRootAsync(options: TransactionalCqrsAsyncOptions): DynamicModule {
    const optionsProvider: FactoryProvider = {
      provide: TRANSACTIONAL_CQRS_OPTIONS,
      useFactory: async (...args: never[]): Promise<ResolvedOptions> =>
        resolveOptions(await options.useFactory(...args)),
      inject: options.inject ? [...options.inject] : undefined,
    };

    return buildModule({ optionsProvider, structural: options, imports: options.imports });
  }
}

/**
 * Shared module shape for both registration paths. The only difference
 * between them is how {@link TRANSACTIONAL_CQRS_OPTIONS} is provided:
 * everything downstream injects that token, so the provider matrix is
 * identical.
 */
function buildModule(args: {
  optionsProvider: Provider;
  structural: TransactionalCqrsStructuralOptions;
  imports?: ModuleMetadata['imports'];
}): DynamicModule {
  // One instance per registration, handed to `CqrsModule.forRoot()` so
  // `EventBus` holds it from its constructor on. Its DI collaborators
  // arrive through `CqrsEventBusBinding`.
  const publisher = new TransactionalEventBusPublisher(args.structural.eventPublisher);

  return {
    module: TransactionalCqrsModule,
    imports: [
      DiscoveryModule,
      CqrsModule.forRoot({ ...args.structural.cqrs, eventPublisher: publisher }),
      ...(args.imports ?? []),
    ],
    providers: [
      args.optionsProvider,
      { provide: CQRS_HANDLER_WRAPPER_OPTIONS, useExisting: TRANSACTIONAL_CQRS_OPTIONS },
      { provide: TransactionalEventBusPublisher, useValue: publisher },
      TransactionalEventDispatcher,
      TransactionalListenerScanner,
      IntegrationEventsHandlerScanner,
      CqrsHandlerWrapper,
      TransactionalCqrsBootstrap,
      CqrsEventBusBinding,
    ],
    exports: [TransactionalEventDispatcher, TransactionalEventBusPublisher],
  };
}
