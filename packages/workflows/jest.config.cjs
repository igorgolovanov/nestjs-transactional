const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/workflows',
  rootDir: '.',
  // Same floors as the outbox bridge, the package this one mirrors.
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 85,
      functions: 93,
      lines: 95,
    },
  },
};
