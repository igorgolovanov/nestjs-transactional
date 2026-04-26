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
      imports: options.imports ?? [],
      providers,
      exports: [EVENT_EXTERNALIZER, MicroservicesEventExternalizer],
    };
  }
}
