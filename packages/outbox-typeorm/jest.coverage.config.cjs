const config = require('./jest.config.cjs');

/**
 * The config the coverage gate runs, and the only place this package's
 * floors live.
 *
 * `jest.config.cjs` inherits `testPathIgnorePatterns` from the base,
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
  //
  // Ratcheted from 88 / 66 / 80 / 88, which had drifted far enough below
  // the real numbers to stop meaning anything: branches had 9.9 points
  // of slack, so a change could have deleted a tenth of the branch
  // coverage and still passed. Measured 91.08 / 75.92 / 85 / 91.44.
  coverageThreshold: {
    global: {
      statements: 91,
      branches: 75,
      functions: 85,
      lines: 91,
    },
  },
};
