const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/outbox-microservices:integration',
  rootDir: '.',
  testRegex: '.*\\.integration\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Kafka is the slow one: the container has to elect a controller and
  // create the topic before the first publish.
  testTimeout: 180_000,
};
