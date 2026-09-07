const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/cqrs',
  rootDir: '.',
  // Baseline floors, not targets — set from measured coverage at the
  // time the gate was introduced (96.4 / 91.7 / 93.8 / 96.8) and meant to
  // ratchet upward. Lowering one is a reviewable change, not a quiet
  // side effect of a merge.
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 90,
      functions: 92,
      lines: 95,
    },
  },
};
