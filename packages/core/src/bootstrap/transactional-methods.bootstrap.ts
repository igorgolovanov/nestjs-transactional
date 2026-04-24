import 'reflect-metadata';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';

import {
  TRANSACTIONAL_METADATA,
  type TransactionalMetadata,
  getTransactionalMetadata,
} from '../decorators/transactional.decorator';
import { WRAPPED_MARKER } from '../internal/markers';
import { TransactionManager } from '../manager/transaction.manager';

/**
 * Metadata keys set by `@nestjs/cqrs`'s handler decorators. Mirrored here
 * so the bootstrap skips CQRS handler classes — they are wrapped by
 * `CqrsHandlerWrapper` in `@nestjs-transactional/cqrs`, which knows how
 * to apply per-kind defaults (read-only queries, etc.). Double-wrapping
 * is additionally guarded via `WRAPPED_MARKER`.
 */
const CQRS_HANDLER_KEYS: readonly string[] = [
  '__commandHandler__',
  '__queryHandler__',
  '__eventsHandler__',
];

type MethodFn = (...args: unknown[]) => unknown;

/**
 * `OnApplicationBootstrap` service that wraps every `@Transactional()`
 * method on a plain `@Injectable()` provider with
 * `TransactionManager.run(...)`.
 *
 * This is the second of the three coordinated wrapping mechanisms
 * described in ADR-005:
 *
 * 1. {@link import('../interceptor/transactional.interceptor').TransactionalInterceptor}
 *    — for controller / resolver / gateway request-boundary handlers.
 * 2. This class — for regular `@Injectable` services.
 * 3. `CqrsHandlerWrapper` (in `@nestjs-transactional/cqrs`) — for CQRS
 *    command / query / event handlers.
 *
 * Skip rules:
 * - CQRS handler classes (detected via `@nestjs/cqrs` metadata keys) are
 *   left alone so their wrapping goes through `CqrsHandlerWrapper`.
 * - Methods already marked with {@link WRAPPED_MARKER} are left alone
 *   (safety net against double-wrap).
 *
 * Metadata lookup priority: method-level `@Transactional` overrides
 * class-level. Classes with only class-level `@Transactional` apply the
 * same options to every method that doesn't carry its own metadata.
 *
 * Registered by `TransactionalModule.forRoot` unless the caller sets
 * `registerMethodsBootstrap: false`.
 */
@Injectable()
export class TransactionalMethodsBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(TransactionalMethodsBootstrap.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly manager: TransactionManager,
  ) {}

  onApplicationBootstrap(): void {
    const providers = this.discovery.getProviders();
    let wrappedCount = 0;

    for (const wrapper of providers) {
      if (wrapper.instance === null || wrapper.instance === undefined) continue;
      if (typeof wrapper.metatype !== 'function') continue;

      const metatype = wrapper.metatype as object;
      if (this.isCqrsHandler(metatype)) continue;

      const instance = wrapper.instance as object;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (prototype === null) continue;

      const classMetadata = getTransactionalMetadata(metatype);
      const methodNames = this.metadataScanner.getAllMethodNames(prototype);
      const methods = prototype as Record<string, unknown>;
      const host = instance as Record<string, unknown>;

      for (const methodName of methodNames) {
        const protoMethod = methods[methodName];
        if (typeof protoMethod !== 'function') continue;

        const metadata = getTransactionalMetadata(protoMethod) ?? classMetadata;
        if (metadata === undefined) continue;

        const currentMethod = host[methodName];
        if (typeof currentMethod !== 'function') continue;
        if (Reflect.getMetadata(WRAPPED_MARKER, currentMethod) === true) continue;

        if (this.wrapMethod(host, methodName, currentMethod as MethodFn, instance, metadata)) {
          wrappedCount++;
        }
      }
    }

    this.logger.log(
      `Wrapped ${wrappedCount} @Transactional method${wrappedCount === 1 ? '' : 's'}`,
    );
  }

  private isCqrsHandler(metatype: object): boolean {
    return CQRS_HANDLER_KEYS.some((key) => Reflect.hasMetadata(key, metatype));
  }

  private wrapMethod(
    host: Record<string, unknown>,
    methodName: string,
    currentMethod: MethodFn,
    instance: object,
    metadata: TransactionalMetadata,
  ): boolean {
    const boundOriginal = currentMethod.bind(instance);
    const manager = this.manager;

    const wrapped = (...args: unknown[]): Promise<unknown> =>
      manager.run(metadata, () => Promise.resolve(boundOriginal(...args)));

    Reflect.defineMetadata(WRAPPED_MARKER, true, wrapped);
    Reflect.defineMetadata(TRANSACTIONAL_METADATA, metadata, wrapped);
    host[methodName] = wrapped;

    this.logger.debug(
      `Wrapped ${instance.constructor.name}.${methodName} ` +
        `(propagation=${metadata.propagation ?? 'REQUIRED'})`,
    );
    return true;
  }
}
