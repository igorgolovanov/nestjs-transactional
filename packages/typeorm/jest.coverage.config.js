const config = require('./jest.config.js');

/**
 * The config the coverage gate runs, and the only place this package's
 * floors live.
 *
 * `jest.config.js` inherits `testPathIgnorePatterns` from the base,
 * which excludes `*.integration.spec.ts` so that `pnpm test` stays
 * Docker-free. Coverage measured through that selection understates
 * this package: the adapter's isolation, savepoint and read-only paths
 * are exercised against a real Postgres, which moved branch coverage
 * from 74 to 84 once the integration suite was counted.
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
      statements: 93,
      branches: 82,
      functions: 94,
      lines: 93,
    },
  },
};
