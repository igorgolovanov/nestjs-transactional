import 'reflect-metadata';

import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
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
 * `@QueryHandler` / `@EventsHandler` class prototype with a transaction,
 * using the handler's own `@Transactional` metadata where present or the
 * kind-specific defaults from {@link HandlerWrapperOptions} otherwise.
 *
 * The replacement is an own-property assignment on each handler class
 * prototype, intercepting `@nestjs/cqrs`'s late-bound
 * `instance.execute(query)` / `instance.handle(event)` lookup. This works
 * for handlers of any scope — `Scope.DEFAULT` (singleton),
 * `Scope.REQUEST`, and `Scope.TRANSIENT` — because the wrap point is the
 * prototype, not any particular instance. See ADR-020.
 *
 * Double-wrap prevention: each wrapped method is tagged with the shared
 * `WRAPPED_MARKER` symbol. Other mechanisms in the coordinated wrapping
 * triad (see ADR-005) honour the same marker.
 *
 * Test isolation: prototype mutation persists across `TestingModule`
 * rebuilds. Call {@link CqrsHandlerWrapper.resetForTesting} in
 * `beforeEach` to restore prototypes between cases. See ADR-020.
 *
 * Limitation: arrow-function `execute = async (q) => {...}` /
 * `handle = async (e) => {...}` defined as instance fields are not
 * wrapped — they live on the instance and shadow the prototype. Use
 * regular method syntax (`async execute(q) { ... }`) so the method
 * lives on the prototype.
 */
@Injectable()
export class CqrsHandlerWrapper implements OnModuleDestroy {
  private readonly logger = new Logger(CqrsHandlerWrapper.name);

  /**
   * Tracks every prototype the wrapper has mutated so
   * {@link CqrsHandlerWrapper.resetForTesting} can restore the
   * originals. Static — shared across wrapper instances (typically one
   * per app; multiple `TestingModule` rebuilds across tests share this
   * tracker and the marker on each prototype method, hence the need
   * for an explicit reset).
   */
  private static readonly wrappedPrototypes = new Map<
    object,
    { methodName: string; originalMethod: HandlerMethod }
  >();

  /**
   * @internal Test-isolation hook (ADR-020). Restores prototype
   * methods mutated by previous `wrapAll` runs and clears the
   * tracker. Call in `beforeEach` when a test suite rebuilds the
   * `TestingModule` between cases — without this, the prototype
   * stays wrapped from the previous test and `WRAPPED_MARKER` makes
   * the next `wrapAll` a no-op, leaving the wrong wrapper (or any
   * wrapper at all, in "leaves unwrapped" assertions) in place.
   *
   * Production code calling this after the wrap loop has finished
   * does not affect already-resolved handler instances — late-bound
   * `instance.execute(query)` resolves to whatever lives on the
   * prototype at call time, which after this call is the original
   * method.
   *
   * Mirrors `OutboxModule.resetForTesting` (ADR-019 § 5).
   */
  static resetForTesting(): void {
    for (const [metatype, { methodName, originalMethod }] of this.wrappedPrototypes) {
      const proto = (metatype as { prototype: Record<string, unknown> }).prototype;
      proto[methodName] = originalMethod;
    }
    this.wrappedPrototypes.clear();
  }

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly manager: TransactionManager,
    @Inject(CQRS_HANDLER_WRAPPER_OPTIONS)
    private readonly options: HandlerWrapperOptions,
  ) {}

  /**
   * NestJS lifecycle hook. When the module closes (`module.close()`,
   * `app.close()`, test teardown via `afterEach: module.close`), restore
   * every wrapped prototype method. This makes subsequent
   * `TestingModule` rebuilds in the same process start from a clean
   * prototype — without it, the `WRAPPED_MARKER` on the previous
   * wrapper short-circuits the next `wrapAll`, leaving a stale closure
   * (over the previous `TransactionManager`) on the prototype.
   *
   * Production effect: none — by the time `onModuleDestroy` fires the
   * app is shutting down and no further bus dispatches occur. The
   * explicit {@link CqrsHandlerWrapper.resetForTesting} static remains
   * available for tests that do not rely on `module.close()` for
   * cleanup.
   */
  onModuleDestroy(): void {
    CqrsHandlerWrapper.resetForTesting();
  }

  /**
   * Scan every provider and wrap handler methods. Safe to call multiple
   * times — the `WRAPPED_MARKER` check guarantees idempotency.
   */
  wrapAll(): void {
    const providers = this.discovery.getProviders();
    let wrappedCount = 0;

    for (const wrapper of providers) {
      if (typeof wrapper.metatype !== 'function') {
        // Value / factory providers have no class constructor — nothing to
        // classify as a CQRS handler.
        continue;
      }

      const metatype = wrapper.metatype as object;
      const kind = this.classifyHandler(metatype);
      if (kind === null) {
        continue;
      }

      const methodName = kind === 'event' ? 'handle' : 'execute';
      if (this.wrapHandler(metatype, methodName, kind)) {
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

  private wrapHandler(metatype: object, methodName: string, kind: HandlerKind): boolean {
    const proto = (metatype as { prototype: Record<string, unknown> }).prototype;
    const protoMethod = proto[methodName];
    if (typeof protoMethod !== 'function') {
      // Method is not on the prototype (e.g. arrow-function instance field).
      // See ADR-020 "Limitations".
      return false;
    }

    if (Reflect.getMetadata(WRAPPED_MARKER, protoMethod) === true) {
      return false;
    }

    const resolved = this.resolveMetadata(protoMethod, metatype, kind);
    if (resolved === undefined) {
      return false;
    }

    const original = protoMethod as HandlerMethod;
    const manager = this.manager;

    // Regular function (not arrow) — `this` is bound by the call site
    // (`instance.execute(query)`) so the wrap composes with any scope of
    // handler instance.
    const wrapped = function (this: object, ...args: unknown[]): Promise<unknown> {
      return manager.run(resolved, () => Promise.resolve(original.apply(this, args)));
    };

    Reflect.defineMetadata(WRAPPED_MARKER, true, wrapped);
    Reflect.defineMetadata(TRANSACTIONAL_METADATA, resolved, wrapped);

    proto[methodName] = wrapped;
    CqrsHandlerWrapper.wrappedPrototypes.set(metatype, { methodName, originalMethod: original });

    this.logger.debug(
      `Wrapped ${kind} handler ${(metatype as { name: string }).name}.prototype.${methodName} ` +
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
