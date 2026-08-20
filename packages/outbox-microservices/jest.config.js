const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/outbox-microservices',
  rootDir: '.',
  // Baseline floors, not targets — set from measured coverage at the
  // time the gate was introduced (98.3 / 66.7 / 100 / 98.2) and meant to
  // ratchet upward. Lowering one is a reviewable change, not a quiet
  // side effect of a merge.
  coverageThreshold: {
    global: {
      statements: 97,
      branches: 65,
      functions: 100,
      lines: 97,
    },
  },
};
