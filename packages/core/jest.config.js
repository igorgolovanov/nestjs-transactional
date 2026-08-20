const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/core',
  rootDir: '.',
  // Baseline floors, not targets — set from measured coverage at the
  // time the gate was introduced (96.9 / 86.8 / 98.8 / 97.9) and meant to
  // ratchet upward. Lowering one is a reviewable change, not a quiet
  // side effect of a merge.
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 85,
      functions: 97,
      lines: 96,
    },
  },
};
