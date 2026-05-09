/**
 * Centralised DI tokens for the three `ClientProxy` registrations.
 * Imported by the events (for `@Externalized({ client })`), the
 * AppModule (for `ClientsModule.register([...])`), and the integration
 * test (for `overrideProvider(...).useValue(mockProxy)`).
 *
 * String tokens — same shape used in `@nestjs/microservices` docs.
 * `Symbol`s would also work, but strings are easier to thread through
 * `@Externalized({ client: 'KAFKA_CLIENT' })` decorators.
 */
export const KAFKA_CLIENT = 'KAFKA_CLIENT';
export const RABBITMQ_CLIENT = 'RABBITMQ_CLIENT';
export const REDIS_CLIENT = 'REDIS_CLIENT';
