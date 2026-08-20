const base = require('../../jest.config.base.js');

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  displayName: '@nestjs-transactional/typeorm',
  rootDir: '.',
  // Baseline floors, not targets — set from measured coverage at the
  // time the gate was introduced (90.9 / 63.6 / 92.1 / 90.9) and meant to
  // ratchet upward. Lowering one is a reviewable change, not a quiet
  // side effect of a merge.
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 62,
      functions: 90,
      lines: 90,
    },
  },
};
