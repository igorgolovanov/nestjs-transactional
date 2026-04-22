import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule, readConfigFromEnv } from './app.module';

/**
 * HTTP-server bootstrap. Tier 5 introduces the REST surface — the
 * earlier tiers all use `createApplicationContext`. Production
 * deployments would also wire `app.enableShutdownHooks()` (see
 * `examples/graceful-shutdown` for the proper pattern); here we
 * keep `main.ts` minimal — the visual demo focuses on the
 * happy-path flow.
 *
 * To exercise the saga, run the docker-compose stack and
 * `pnpm start`, then:
 *
 *   curl -X POST http://localhost:3000/orders \
 *     -H 'content-type: application/json' \
 *     -d '{"customerId":"c-1","items":[{"sku":"WIDGET","quantity":2,"unitPriceCents":1000}]}'
 *
 *   curl http://localhost:3000/orders/<orderId>
 *
 * Within ~1 second the order moves through `placed → confirmed`
 * and an `OrderConfirmedEvent` lands on Kafka topic
 * `orders.confirmed`.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule.forConfig(readConfigFromEnv()), {
    logger: ['error', 'warn', 'log'],
  });
  await app.listen(3000);
  Logger.log('e-commerce-orders listening on http://localhost:3000', 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console -- bootstrap fault, no logger yet.
  console.error(err);
  process.exit(1);
});
