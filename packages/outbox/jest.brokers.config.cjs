const base = require('../../jest.config.base.js');

/**
 * The broker suite: what a real Kafka and RabbitMQ acknowledgement means
 * for an outbox message (ADR-021). Kept apart from the integration suite
 * so the TypeORM matrix does not start two brokers per leg; CI runs it
 * once, in its own job.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/outbox:brokers',
  rootDir: '.',
  testRegex: '.*\\.brokers\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 180_000,
};
