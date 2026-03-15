import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
import { EVENT_EXTERNALIZER } from '@nestjs-transactional/outbox';

import { MicroservicesEventExternalizer } from '../externalizer/microservices-event-externalizer';
import {
  OUTBOX_MICROSERVICES_OPTIONS,
  type OutboxMicroservicesOptions,
} from '../types/options';

/**
 * Async-options shape for {@link OutboxMicroservicesModule.forRootAsync}.
 * `imports` follows NestJS convention so the factory can pull values
 * from a `ConfigModule` (or similar) without leaking the module
 * reference into the factory signature.
 */
export interface OutboxMicroservicesAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  readonly useFactory: (
    ...args: never[]
  ) => Promise<OutboxMicroservicesOptions> | OutboxMicroservicesOptions;
  readonly inject?: readonly InjectionToken[];
}

/**
 * NestJS module that wires the
 * {@link MicroservicesEventExternalizer} as the
 * `EventExternalizer` for `outbox`. Reuses the user's existing
 * `@nestjs/microservices` `ClientsModule` registration (DD-017) — the
 * package does NOT register clients itself.
 *
 * Typical wiring:
 * ```ts
 * @Module({
 *   imports: [
 *     ClientsModule.register([
 *       { name: 'KAFKA_CLIENT', transport: Transport.KAFKA, options: { ... } },
 *     ]),
 *     OutboxModule.forRoot({}),
 *     OutboxModule.forFeature([OrderPlacedEvent]),
 *     OutboxMicroservicesModule.forRoot({ defaultClient: 'KAFKA_CLIENT' }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * The module binds {@link EVENT_EXTERNALIZER} via `useExisting` so
 * `OutboxModule`'s `EventPublicationProcessor` picks the externalizer
 * up through its `@Optional()` injection (DD-018). Both the SPI
 * binding and the concrete class are exported so consumers can inject
 * either.
 *
 * **Multi-dataSource setups**: a single externalizer covers every
 * dataSource. Per-broker routing — when different events should land
 * on different transports — happens via the per-event
 * `@Externalized({ client })` parameter (Phase 11.3), not via a
 * dataSource-keyed externalizer Map. See `outbox` README for the
 * multi-`OutboxModule.forRoot()` pattern (ADR-019); each per-DS
 * processor injects this same externalizer via `EVENT_EXTERNALIZER`.
 *
 * The module is registered as `@Global()` (since Phase 14.6) so the
 * `EVENT_EXTERNALIZER` binding is visible to `OutboxModule`'s
 * sibling-imported per-DS processors without an explicit import
 * chain. Pre-Phase-14.6 the module was non-global, which silently
 * broke the documented usage pattern in multi-module trees — fixed
 * in Phase 14.6 verification work.
 */
@Module({})
export class OutboxMicroservicesModule {
  static forRoot(options: OutboxMicroservicesOptions = {}): DynamicModule {
    const providers: Provider[] = [
      { provide: OUTBOX_MICROSERVICES_OPTIONS, useValue: options },
      MicroservicesEventExternalizer,
      { provide: EVENT_EXTERNALIZER, useExisting: MicroservicesEventExternalizer },
    ];

    return {
      module: OutboxMicroservicesModule,
      global: true,
      providers,
      exports: [EVENT_EXTERNALIZER, MicroservicesEventExternalizer],
    };
  }

  static forRootAsync(options: OutboxMicroservicesAsyncOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: OUTBOX_MICROSERVICES_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject ? [...options.inject] : undefined,
      },
      MicroservicesEventExternalizer,
      { provide: EVENT_EXTERNALIZER, useExisting: MicroservicesEventExternalizer },
    ];

    return {
      module: OutboxMicroservicesModule,
      global: true,
      imports: options.imports ?? [],
      providers,
      exports: [EVENT_EXTERNALIZER, MicroservicesEventExternalizer],
    };
  }
}
