import * as Joi from 'joi';

/**
 * Joi schema applied to `process.env` by `ConfigModule.forRoot`. The
 * module evaluates this once on bootstrap; missing or out-of-range
 * values throw before the DI tree starts wiring, so a malformed
 * deployment fails fast rather than crashing mid-request.
 *
 * Pair with `validationOptions: { abortEarly: false }` (set in
 * `app.module.ts`) so operators see every problem in one pass.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'staging', 'production', 'test')
    .default('development'),

  PG_HOST: Joi.string().required(),
  PG_PORT: Joi.number().integer().min(1).max(65_535).default(5432),
  PG_USER: Joi.string().required(),
  PG_PASSWORD: Joi.string().required(),
  PG_DATABASE: Joi.string().required(),

  // Outbox tunables — different per environment so the example
  // demonstrates that `forRootAsync` actually injects the resolved
  // values. dev polls fast (snappy local feedback), prod polls
  // slower (kinder to the DB under load).
  OUTBOX_POLLING_INTERVAL_MS: Joi.number().integer().min(50).max(60_000).required(),
  OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(1_000).required(),
  OUTBOX_MAX_CONCURRENT: Joi.number().integer().min(1).max(100).required(),

  HTTP_PORT: Joi.number().integer().min(1).max(65_535).default(3000),
});

/**
 * Typed shape of the validated env. Keep in sync with the schema
 * above — a refactor that adds a key here MUST also add a `Joi`
 * rule, otherwise an unvalidated value reaches runtime.
 */
export interface ValidatedEnv {
  readonly NODE_ENV: 'development' | 'staging' | 'production' | 'test';

  readonly PG_HOST: string;
  readonly PG_PORT: number;
  readonly PG_USER: string;
  readonly PG_PASSWORD: string;
  readonly PG_DATABASE: string;

  readonly OUTBOX_POLLING_INTERVAL_MS: number;
  readonly OUTBOX_BATCH_SIZE: number;
  readonly OUTBOX_MAX_CONCURRENT: number;

  readonly HTTP_PORT: number;
}

/**
 * Database connection block extracted from the validated env. Used
 * by the `TypeOrmModule.forRootAsync` factory.
 */
export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
}

/**
 * Outbox processor tunables extracted from the validated env. Used
 * by the `OutboxModule.forRootAsync` factory.
 */
export interface OutboxConfig {
  readonly pollingInterval: number;
  readonly batchSize: number;
  readonly maxConcurrent: number;
}
