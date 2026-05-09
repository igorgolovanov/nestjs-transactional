import 'reflect-metadata';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import {
  PropagationMode,
  TRANSACTIONAL_METADATA,
  TransactionManager,
  type TransactionalMetadata,
  getTransactionalMetadata,
} from '@nestjs-transactional/core';

/**
 * Metadata keys written by `@nestjs/cqrs`'s `@CommandHandler` /
 * `@QueryHandler` / `@EventsHandler` decorators onto the handler class
 * constructor. The package does NOT re-export these from its public
 * barrel — we mirror them here because we read them at wrap time to
 * identify CQRS handlers.
 *
 * Values must match the strings in
 * `node_modules/@nestjs/cqrs/dist/decorators/constants.js`. Coupling to
 * `@nestjs/cqrs` internals is explicitly accepted per DD-002
 * (`docs/dd/002-no-fork-nestjs-cqrs.md`) — we prefer wrapping
 * to forking.
 */
const COMMAND_HANDLER_METADATA = '__commandHandler__';
const QUERY_HANDLER_METADATA = '__queryHandler__';
const EVENTS_HANDLER_METADATA = '__eventsHandler__';

/**
 * Process-global identity for the "already wrapped" marker, matching
 * `WRAPPED_MARKER` in the core package. `Symbol.for` resolves to the same
 * symbol across any copy of the package tree, so a method wrapped by
 * `TransactionalMethodsBootstrap` (core) will still be recognized by us
 * and vice versa. Core does not re-export this symbol from its public
 * barrel; its JSDoc documents re-derivation via `Symbol.for` as supported.
 */
const WRAPPED_MARKER: symbol = Symbol.for('@nestjs-transactional/wrapped');

/**
 * DI injection token for {@link HandlerWrapperOptions}. The wrapper reads
 * options via this token so `CqrsTransactionalModule` can provide them
 * synchronously or asynchronously.
 */
export const CQRS_HANDLER_WRAPPER_OPTIONS = Symbol('CQRS_HANDLER_WRAPPER_OPTIONS');

/**
 * Options that control which CQRS handler kinds are wrapped and how the
 * transaction is configured when the handler has no explicit
 * `@Transactional()` metadata.
 */
export interface HandlerWrapperOptions {
  /** Wrap `@CommandHandler`-decorated classes. Default: `true`. */
  readonly wrapCommandHandlers?: boolean;

  /** Wrap `@QueryHandler`-decorated classes. Default: `true`. */
  readonly wrapQueryHandlers?: boolean;

  /** Wrap `@EventsHandler`-decorated classes. Default: `true`. */
  readonly wrapEventHandlers?: boolean;

  /**
   * Fallback metadata applied to query handlers that carry no
   * `@Transactional` annotation. Typically `{ readOnly: true }`. When
   * omitted, undecorated query handlers are left unwrapped (no
   * transaction).
   */
  readonly defaultQueryOptions?: Partial<TransactionalMetadata>;

  /**
   * Fallback metadata applied to command handlers that carry no
   * `@Transactional` annotation. When omitted, undecorated command
   * handlers are left unwrapped.
   */
  readonly defaultCommandOptions?: Partial<TransactionalMetadata>;
}

type HandlerKind = 'command' | 'query' | 'event';

type HandlerMethod = (...args: unknown[]) => unknown;

/**
 * Wraps the `execute` (or `handle`) method of every `@CommandHandler` /
 * `@QueryHandler` / `@EventsHandler` instance with a transaction, using
 * the handler's own `@Transactional` metadata where present or the
 * kind-specific defaults from {@link HandlerWrapperOptions} otherwise.
 *
 * The replacement is an own-property assignment on each handler instance,
 * shadowing the prototype method. `@nestjs/cqrs`'s buses resolve
 * `instance.execute` / `instance.handle` at call time (late binding), so
 * the wrap takes effect for every subsequent bus dispatch.
 *
 * Double-wrap prevention: each wrapped method is tagged with the shared
 * `WRAPPED_MARKER` symbol. Other mechanisms in the coordinated wrapping
 * triad (see ADR-005) honour the same marker.
 *
 * Limitation: only works with static-dependency-tree (singleton) handlers.
 * Request-scoped handlers are resolved per-request by `@nestjs/cqrs`'s
 * `ModuleRef.resolve`, which produces a fresh instance our wrap has not
 * mutated.
 */
@Injectable()
export class CqrsHandlerWrapper {
  private readonly logger = new Logger(CqrsHandlerWrapper.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly manager: TransactionManager,
    @Inject(CQRS_HANDLER_WRAPPER_OPTIONS)
    private readonly options: HandlerWrapperOptions,
  ) {}

  /**
   * Scan every provider and wrap handler methods. Safe to call multiple
   * times — the `WRAPPED_MARKER` check guarantees idempotency.
   */
  wrapAll(): void {
    const providers = this.discovery.getProviders();
    let wrappedCount = 0;

    for (const wrapper of providers) {
      if (wrapper.instance === null || wrapper.instance === undefined) {
        continue;
      }
      if (typeof wrapper.metatype !== 'function') {
        // Value / factory providers have no class constructor — nothing to
        // classify as a CQRS handler.
        continue;
      }

      const instance = wrapper.instance as object;
      const metatype = wrapper.metatype as object;
      const kind = this.classifyHandler(metatype);
      if (kind === null) {
        continue;
      }

      const methodName = kind === 'event' ? 'handle' : 'execute';
      if (this.wrapHandler(instance, metatype, methodName, kind)) {
        wrappedCount++;
      }
    }

    this.logger.log(
      `Wrapped ${wrappedCount} CQRS handler${wrappedCount === 1 ? '' : 's'} with @Transactional`,
    );
  }

  private classifyHandler(metatype: object): HandlerKind | null {
    if (
      this.options.wrapCommandHandlers !== false &&
      Reflect.hasMetadata(COMMAND_HANDLER_METADATA, metatype)
    ) {
      return 'command';
    }
    if (
      this.options.wrapQueryHandlers !== false &&
      Reflect.hasMetadata(QUERY_HANDLER_METADATA, metatype)
    ) {
      return 'query';
    }
    if (
      this.options.wrapEventHandlers !== false &&
      Reflect.hasMetadata(EVENTS_HANDLER_METADATA, metatype)
    ) {
      return 'event';
    }
    return null;
  }

  private wrapHandler(
    instance: object,
    metatype: object,
    methodName: string,
    kind: HandlerKind,
  ): boolean {
    const host = instance as Record<string, unknown>;
    const currentMethod = host[methodName];
    if (typeof currentMethod !== 'function') {
      return false;
    }

    if (Reflect.getMetadata(WRAPPED_MARKER, currentMethod) === true) {
      return false;
    }

    const resolved = this.resolveMetadata(currentMethod, metatype, kind);
    if (resolved === undefined) {
      return false;
    }

    const boundOriginal = (currentMethod as HandlerMethod).bind(instance);
    const manager = this.manager;

    const wrapped = (...args: unknown[]): Promise<unknown> =>
      manager.run(resolved, () => Promise.resolve(boundOriginal(...args)));

    Reflect.defineMetadata(WRAPPED_MARKER, true, wrapped);
    Reflect.defineMetadata(TRANSACTIONAL_METADATA, resolved, wrapped);

    host[methodName] = wrapped;
    this.logger.debug(
      `Wrapped ${kind} handler ${instance.constructor.name}.${methodName} ` +
        `(propagation=${resolved.propagation ?? PropagationMode.REQUIRED})`,
    );
    return true;
  }

  /**
   * Priority order: method-level `@Transactional` > class-level
   * `@Transactional` > kind-specific defaults. Returns `undefined` when
   * nothing applies — the handler is then left unwrapped.
   */
  private resolveMetadata(
    method: object,
    metatype: object,
    kind: HandlerKind,
  ): TransactionalMetadata | undefined {
    const explicit = getTransactionalMetadata(method) ?? getTransactionalMetadata(metatype);
    if (explicit !== undefined) {
      return explicit;
    }

    const defaults = this.pickDefaults(kind);
    if (defaults === undefined) {
      return undefined;
    }

    return { propagation: PropagationMode.REQUIRED, ...defaults };
  }

  private pickDefaults(kind: HandlerKind): Partial<TransactionalMetadata> | undefined {
    switch (kind) {
      case 'query':
        return this.options.defaultQueryOptions;
      case 'command':
        return this.options.defaultCommandOptions;
      case 'event':
        return undefined;
    }
  }
}
