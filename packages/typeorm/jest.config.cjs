const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/typeorm',
  rootDir: '.',
  // No `coverageThreshold` here on purpose. This config excludes the
  // integration suite so `pnpm test` needs no Docker, and gating on a
  // selection that skips those tests understated the package. The floors
  // live in `jest.coverage.config.js`, which is what `test:cov` runs.
};
