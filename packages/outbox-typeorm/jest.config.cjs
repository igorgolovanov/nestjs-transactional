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
  // No `coverageThreshold` here on purpose. This config excludes the
  // integration suite so `pnpm test` needs no Docker, and `src/module/`
  // is exercised almost entirely from testcontainers, so gating on this
  // selection reported roughly half the real coverage. The floors live
  // in `jest.coverage.config.js`, which is what `test:cov` runs.
};
