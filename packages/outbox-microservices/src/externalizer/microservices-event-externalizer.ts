import {
  Inject,
  Injectable,
  type InjectionToken,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { type ClientProxy } from '@nestjs/microservices';
import {
  type EventExternalizer,
  ExternalizationError,
  type ExternalizationMetadata,
} from '@nestjs-transactional/outbox';
import { firstValueFrom } from 'rxjs';

import {
  OUTBOX_MICROSERVICES_OPTIONS,
  type OutboxMicroservicesOptions,
} from '../types/options';

/**
 * {@link EventExternalizer} implementation backed by `@nestjs/microservices`
 * `ClientProxy`. Routes externalized events to whichever transport
 * the configured `ClientProxy` was registered with — Kafka, RabbitMQ,
 * NATS, JMS, gRPC, or any custom transport.
 *
 * Per DD-017 this externalizer does NOT register clients itself;
 * users register them via standard `ClientsModule.register()` /
 * `ClientsModule.registerAsync()` and pass the token through
 * `OutboxMicroservicesModule.forRoot({ defaultClient })`. Per-event
 * overrides via `@Externalized({ client })` resolve through the same
 * `ModuleRef.get(token, { strict: false })` lookup.
 *
 * **Headers / routingKey limitation (Phase 11.3):** the
 * `@nestjs/microservices` `ClientProxy.emit` API has no unified
 * headers / routing-key parameter — handling is transport-specific
 * (Kafka headers, AMQP properties, NATS subject suffixes, ...). For
 * the first version we log resolved headers and routing keys at debug
 * level for visibility but do not apply them to the wire payload —
 * users that need them can wrap the event in a transport-specific
 * envelope inside their own code or wait for the broker-aware message
 * construction iteration.
 */
@Injectable()
export class MicroservicesEventExternalizer
  implements EventExternalizer, OnApplicationBootstrap
{
  private readonly logger = new Logger(MicroservicesEventExternalizer.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(OUTBOX_MICROSERVICES_OPTIONS)
    private readonly options: OutboxMicroservicesOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (this.options.validateOnBootstrap === false) {
      this.logger.log('Bootstrap validation disabled — defaultClient will be resolved on first externalize() call');
      return;
    }

    if (this.options.defaultClient === undefined) {
      this.logger.log(
        'No defaultClient configured — every @Externalized event must specify its own client',
      );
      return;
    }

    try {
      this.resolveClient(this.options.defaultClient);
      this.logger.log(
        `Externalization configured with default client: ${formatToken(this.options.defaultClient)}`,
      );
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `OutboxMicroservicesModule: defaultClient '${formatToken(this.options.defaultClient)}' ` +
          `is not registered in the DI container. Register the ClientProxy via ` +
          `ClientsModule.register() / ClientsModule.registerAsync(), or pass ` +
          `validateOnBootstrap: false to defer resolution to the first event. ` +
          `Original error: ${cause}`,
      );
    }
  }

  async externalize(event: unknown, metadata: ExternalizationMetadata): Promise<void> {
    const clientToken = metadata.client ?? this.options.defaultClient;
    if (clientToken === undefined) {
      throw new ExternalizationError(
        `No ClientProxy specified for event ${metadata.eventType}. ` +
          `Set defaultClient on OutboxMicroservicesModule.forRoot() or pass ` +
          `'client' in the @Externalized() decorator options.`,
        metadata.eventType,
        metadata.target,
      );
    }

    let client: ClientProxy;
    try {
      client = this.resolveClient(clientToken);
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      const causeMessage = err instanceof Error ? err.message : String(err);
      throw new ExternalizationError(
        `ClientProxy '${formatToken(clientToken)}' not found in the DI container. ` +
          `Ensure it is registered via ClientsModule.register() / registerAsync(). ` +
          `Original error: ${causeMessage}`,
        metadata.eventType,
        metadata.target,
        cause,
      );
    }

    if (metadata.headers !== undefined || metadata.routingKey !== undefined) {
      // Phase 11.3 limitation — ClientProxy.emit has no unified
      // headers / routing-key parameter. Logged for visibility; the
      // broker-aware message construction iteration will route them
      // through transport-specific envelopes.
      this.logger.debug(
        `${metadata.eventType}: headers/routingKey are not applied to the wire payload in this version (Phase 11.3 limitation): ${JSON.stringify(
          { headers: metadata.headers, routingKey: metadata.routingKey },
        )}`,
      );
    }

    try {
      await firstValueFrom(client.emit(metadata.target, event));
      this.logger.debug(
        `Externalized ${metadata.eventType} → ${metadata.target} (client: ${formatToken(clientToken)})`,
      );
    } catch (err) {
      const cause = err instanceof Error ? err : undefined;
      const causeMessage = err instanceof Error ? err.message : String(err);
      throw new ExternalizationError(
        `Failed to publish ${metadata.eventType} to ${metadata.target}: ${causeMessage}`,
        metadata.eventType,
        metadata.target,
        cause,
      );
    }
  }

  private resolveClient(token: InjectionToken): ClientProxy {
    const proxy = this.moduleRef.get<ClientProxy>(token, { strict: false });
    if (proxy === null || proxy === undefined) {
      throw new Error('Resolved provider is null/undefined');
    }
    return proxy;
  }
}

function formatToken(token: InjectionToken): string {
  if (typeof token === 'symbol') {
    return token.toString();
  }
  if (typeof token === 'function') {
    return token.name || '<anonymous function token>';
  }
  return String(token);
}
