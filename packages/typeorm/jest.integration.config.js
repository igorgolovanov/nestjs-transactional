const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/typeorm:integration',
  rootDir: '.',
  testRegex: '.*\\.integration\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Testcontainers needs time to pull / start the container on first run.
  testTimeout: 60_000,
};
