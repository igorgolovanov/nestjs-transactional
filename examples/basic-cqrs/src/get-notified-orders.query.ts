import { type IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { NotificationHandler } from './notification.handler';

/**
 * Returns the list of order ids the in-memory `NotificationHandler`
 * has observed via AFTER_COMMIT delivery so far. A trivial query —
 * a real app would query a `Repository` instead — but the focus is
 * showing how queries cooperate with `@nestjs-transactional/cqrs`:
 *
 * - `CqrsHandlerWrapper` decorates `execute` at bootstrap (the cqrs
 *   package's `OnApplicationBootstrap` mechanism).
 * - `CqrsTransactionalModule.forRoot()` defaults
 *   `defaultQueryOptions = { readOnly: true }`, so the wrapped
 *   transaction is read-only — a hint that downstream adapters
 *   (TypeORM, Prisma) can use to optimize or to refuse writes.
 */
export class GetNotifiedOrdersQuery {}

@QueryHandler(GetNotifiedOrdersQuery)
export class GetNotifiedOrdersHandler implements IQueryHandler<GetNotifiedOrdersQuery, string[]> {
  constructor(private readonly notifications: NotificationHandler) {}

  async execute(): Promise<string[]> {
    return [...this.notifications.notified];
  }
}
