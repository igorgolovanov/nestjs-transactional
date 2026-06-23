const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/outbox',
  rootDir: '.',
  // Baseline floors, not targets — set from measured coverage at the
  // time the gate was introduced (96.2 / 86.6 / 94.2 / 96.1) and meant to
  // ratchet upward. Lowering one is a reviewable change, not a quiet
  // side effect of a merge.
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 85,
      functions: 93,
      lines: 95,
    },
  },
};
