const config = require('./jest.config.js');

/**
 * The config the coverage gate runs, and the only place this package's
 * floors live.
 *
 * `jest.config.js` inherits `testPathIgnorePatterns` from the base,
 * which excludes `*.integration.spec.ts` so that `pnpm test` stays
 * Docker-free. Measuring coverage through that selection was
 * misleading here: `src/module/` and the schema helpers are exercised
 * almost entirely from the testcontainers suite, so the gate saw 34 of
 * this package's 55 tests as if they did not exist and reported
 * 62 / 31 / 42 / 61 where the real figures are 90 / 69 / 83 / 90.
 *
 * Requires Docker, unlike `pnpm test`.
 */
/** @type {import('jest').Config} */
module.exports = {
  ...config,
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Testcontainers needs time to pull / start the container on first run.
  testTimeout: 60_000,
  // Floors, not targets, set just under the measured combined coverage
  // and meant to ratchet up. See CONTRIBUTING, "Coverage gate".
  coverageThreshold: {
    global: {
      statements: 88,
      branches: 66,
      functions: 80,
      lines: 88,
    },
  },
};
