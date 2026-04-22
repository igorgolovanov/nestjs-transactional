/**
 * Single Kafka `ClientProxy` registration. The `OrderConfirmedEvent`
 * leaves the system through it.
 *
 * The `ClientsModule.register({ name, transport, options })` call is
 * in `app.module.ts`. Application code only depends on the token name
 * — DI resolves the actual proxy. Tests substitute a mocked proxy
 * under the same token without changing any production code.
 */
export const KAFKA_CLIENT = 'KAFKA_CLIENT';
