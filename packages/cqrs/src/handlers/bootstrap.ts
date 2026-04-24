import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';

import { CqrsHandlerWrapper } from './handler-wrapper';

/**
 * Fires `CqrsHandlerWrapper.wrapAll` at application bootstrap, after all
 * `onModuleInit` hooks (including `@nestjs/cqrs`'s explorer) have
 * completed. `@nestjs/cqrs`'s bus bindings resolve `instance.execute` at
 * call time, so a late wrap still takes effect for every subsequent
 * dispatch.
 *
 * Registered by `CqrsTransactionalModule` (added in a later iteration).
 * Not intended for direct consumer instantiation.
 */
@Injectable()
export class CqrsTransactionalBootstrap implements OnApplicationBootstrap {
  constructor(private readonly wrapper: CqrsHandlerWrapper) {}

  onApplicationBootstrap(): void {
    this.wrapper.wrapAll();
  }
}
