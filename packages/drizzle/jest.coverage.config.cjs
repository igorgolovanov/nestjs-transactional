const config = require('./jest.config.cjs');

/**
 * The config the coverage gate runs, and the only place this package's
 * floors live.
 *
 * `jest.config.cjs` inherits `testPathIgnorePatterns` from the base,
 * which excludes `*.integration.spec.ts` so that `pnpm test` stays
 * Docker-free. This config counts the integration suite too, so it
 * requires Docker, unlike `pnpm test`.
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
      statements: 98,
      branches: 90,
      functions: 95,
      lines: 98,
    },
  },
};
