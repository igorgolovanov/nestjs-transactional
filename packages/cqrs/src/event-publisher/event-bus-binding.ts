import { Inject, Injectable, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { AsyncContext, EventBus, type IEvent, type IEventPublisher } from '@nestjs/cqrs';
import {
  type ActiveTransaction,
  TransactionContext,
  TransactionManager,
} from '@nestjs-transactional/core';

import { TransactionalEventDispatcher } from '../event-dispatcher/event-dispatcher.js';
import { CQRS_TRANSACTIONAL_OPTIONS } from '../module/tokens.js';

import {
  OUTBOX_PUBLICATION_SCHEDULER,
  type OutboxPublicationScheduler,
} from './outbox-publication-scheduler.js';
import { TransactionalEventBusPublisher, isThenable } from './transactional-event-bus-publisher.js';

const WRAPPED = Symbol.for('@nestjs-transactional/cqrs/event-bus-wrapped');

type Publish = (event: IEvent, context?: unknown, asyncContext?: AsyncContext) => unknown;
type PublishAll = (events: IEvent[], context?: unknown, asyncContext?: AsyncContext) => unknown;

/**
 * Connects {@link TransactionalEventBusPublisher} to DI and to the
 * `EventBus` (DD-029):
 *
 * - it hands the publisher its collaborators, and the in-memory delivery
 *   to `@EventsHandler`s that `@nestjs/cqrs`'s default publisher would
 *   have done;
 * - it wraps `EventBus.publish` and `publishAll` on the instance, so
 *   every publish inside a transaction, whatever publisher wraps ours,
 *   carries `{ transaction }` in its dispatcher context, and its
 *   asynchronous work finishes before the transaction commits;
 * - at bootstrap, it fails if the `EventBus` no longer reaches the
 *   publisher, which a second `CqrsModule.forRoot()` or a replaced
 *   `EventBus.publisher` would cause, silently, otherwise.
 */
@Injectable()
export class CqrsEventBusBinding implements OnApplicationBootstrap {
  private readonly dataSource: string;

  constructor(
    private readonly eventBus: EventBus,
    private readonly publisher: TransactionalEventBusPublisher,
    dispatcher: TransactionalEventDispatcher,
    private readonly manager: TransactionManager,
    private readonly discovery: DiscoveryService,
    @Inject(CQRS_TRANSACTIONAL_OPTIONS) options: { readonly eventsDataSource?: string },
    @Optional() @Inject(OUTBOX_PUBLICATION_SCHEDULER) outbox?: OutboxPublicationScheduler,
  ) {
    this.dataSource = options.eventsDataSource ?? 'default';
    publisher.attach({
      dispatcher,
      outbox,
      inner: publisher.delegate ?? {
        publish: (event: IEvent) => {
          eventBus.subject$.next(event);
        },
      },
    });
    this.wrap(eventBus);
  }

  onApplicationBootstrap(): void {
    const buses = new Set(
      this.discovery
        .getProviders()
        .map((wrapper) => wrapper.instance as unknown)
        .filter((instance): instance is EventBus => instance instanceof EventBus),
    );
    if (buses.size > 1) {
      throw new Error(
        `Found ${buses.size} @nestjs/cqrs EventBus instances. CqrsTransactionalModule imports ` +
          'CqrsModule.forRoot() itself; importing CqrsModule again creates a second EventBus that ' +
          'bypasses the transactional publisher. Remove the other CqrsModule import and pass its ' +
          'options as CqrsTransactionalModule.forRoot({ cqrs: { ... } }).',
      );
    }
    if (!reaches(this.eventBus.publisher, this.publisher)) {
      const name = (this.eventBus.publisher as object | undefined)?.constructor?.name ?? 'nothing';
      throw new Error(
        `EventBus.publisher was replaced (by ${name}) with a publisher that does not wrap ` +
          "CqrsTransactionalModule's, so events would bypass transaction phases and the outbox. " +
          'Pass your publisher as CqrsTransactionalModule.forRoot({ eventPublisher }) instead, ' +
          'or wrap the existing EventBus.publisher rather than replacing it.',
      );
    }
  }

  private wrap(eventBus: EventBus): void {
    const target = eventBus as unknown as Record<PropertyKey, unknown>;
    if (target[WRAPPED] === true) {
      return;
    }
    const publish = eventBus.publish.bind(eventBus) as Publish;
    const publishAll = eventBus.publishAll.bind(eventBus) as PublishAll;

    target.publish = (event: IEvent, contextOrAsync?: unknown, asyncContext?: AsyncContext) => {
      const [context, async] = split(contextOrAsync, asyncContext);
      const active = this.active();
      return this.track(active, publish(event, this.contextFor(active, context), async));
    };
    target.publishAll = (
      events: IEvent[],
      contextOrAsync?: unknown,
      asyncContext?: AsyncContext,
    ) => {
      const [context, async] = split(contextOrAsync, asyncContext);
      const active = this.active();
      return this.track(active, publishAll(events, this.contextFor(active, context), async));
    };
    target[WRAPPED] = true;
  }

  private active(): ActiveTransaction | undefined {
    return TransactionContext.getActiveTransactionByDataSource(this.dataSource);
  }

  /**
   * The dispatcher context to publish with. A context the caller chose
   * is kept; none, or the aggregate `EventPublisher` passes by default,
   * becomes `{ transaction }` inside a transaction, the convention
   * `@nestjs/workflows` and the `@nestjs/cqrs` documentation use.
   */
  private contextFor(active: ActiveTransaction | undefined, context: unknown): unknown {
    if (active === undefined || (context !== undefined && !isAggregate(context))) {
      return context;
    }
    let transaction: unknown;
    try {
      transaction = this.manager.nativeTransactionOf(active);
    } catch {
      return context;
    }
    return isAggregate(context) ? { transaction, aggregate: context } : { transaction };
  }

  /**
   * A publisher that wraps ours may finish asynchronously, after the
   * caller stopped waiting: `AggregateRoot.commit()` drops the promise on
   * `@nestjs/cqrs` 11. Inside a transaction, its work must still land
   * before COMMIT, and a failure must roll it back.
   */
  private track(active: ActiveTransaction | undefined, result: unknown): unknown {
    if (active === undefined) {
      return result;
    }
    if (isThenable(result)) {
      this.manager.trackPending(active, Promise.resolve(result));
    } else if (Array.isArray(result) && result.some(isThenable)) {
      this.manager.trackPending(active, Promise.all(result));
    }
    return result;
  }
}

function split(
  contextOrAsync: unknown,
  asyncContext: AsyncContext | undefined,
): [unknown, AsyncContext | undefined] {
  if (asyncContext === undefined && contextOrAsync instanceof AsyncContext) {
    return [undefined, contextOrAsync];
  }
  return [contextOrAsync, asyncContext];
}

function isAggregate(context: unknown): boolean {
  return (
    typeof (context as { getUncommittedEvents?: unknown } | null)?.getUncommittedEvents ===
    'function'
  );
}

/**
 * Whether `publisher` is `target` or wraps it, through any property of
 * any depth up to a few levels: wrappers name the field they keep the
 * wrapped publisher in differently (`WorkflowEventPublisher` uses
 * `inner`).
 */
function reaches(publisher: IEventPublisher | undefined, target: object, depth = 4): boolean {
  if (publisher === target) {
    return true;
  }
  if (publisher === undefined || publisher === null || depth === 0) {
    return false;
  }
  return Object.values(publisher as object).some(
    (value) =>
      typeof (value as { publish?: unknown } | null)?.publish === 'function' &&
      reaches(value as IEventPublisher, target, depth - 1),
  );
}
