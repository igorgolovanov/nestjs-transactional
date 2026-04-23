import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, defer, firstValueFrom } from 'rxjs';

import {
  TRANSACTIONAL_METADATA,
  type TransactionalMetadata,
} from '../decorators/transactional.decorator';
import { TransactionManager } from '../manager/transaction.manager';

/**
 * NestJS interceptor that wraps a request-boundary handler in a transaction
 * when the handler (or its controller class) carries `@Transactional()`
 * metadata.
 *
 * Registered at the request boundary via `APP_INTERCEPTOR`. It is one of
 * the three coordinated wrapping mechanisms described in ADR-005 — the
 * other two are `TransactionalMethodsBootstrap` (for plain `@Injectable`
 * services) and `CqrsHandlerWrapper` (for CQRS handlers).
 *
 * Metadata lookup: method-level `@Transactional` overrides class-level.
 * If neither is present the handler is passed through without any
 * transactional wrapping.
 *
 * Not exported from the package's public API — consumers enable it via
 * `TransactionalModule.forRoot`.
 */
@Injectable()
export class TransactionalInterceptor implements NestInterceptor {
  constructor(
    private readonly manager: TransactionManager,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<TransactionalMetadata>(
      TRANSACTIONAL_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (metadata === undefined) {
      return next.handle();
    }

    return defer(() => this.manager.run(metadata, () => firstValueFrom(next.handle())));
  }
}
