const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/outbox-typeorm',
  rootDir: '.',
  collectCoverageFrom: [
    ...base.collectCoverageFrom,
    // TypeORM migrations are executed by TypeORM's own runner and are
    // verified end-to-end by `test/integration/`. Their `up`/`down`
    // bodies only delegate to the schema helpers, which the unit suite
    // covers directly.
    '!src/migrations/**',
  ],
  // Baseline floors, not targets. `src/module/` is deliberately included
  // even though its coverage comes almost entirely from the
  // testcontainers integration suite — the numbers stay honest about
  // what the Docker-free suite actually exercises, and ratchet up as
  // unit coverage grows (improvement plan, item B3).
  coverageThreshold: {
    global: {
      statements: 60,
      branches: 20,
      functions: 40,
      lines: 59,
    },
  },
};
