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
  //
  // Unlike `typeorm` and `outbox-typeorm`, this package has no
  // `jest.coverage.config.js` folding its integration suite into the
  // measurement, and that is deliberate rather than an omission. Those
  // two needed it because excluding their suites understated them badly
  // (`outbox-typeorm` reported 62 / 31 against a real 90 / 69). Here the
  // unit tests already cover the one source file at 98, so pulling the
  // broker suite in would move the numbers by roughly nothing while
  // making the coverage job start Kafka and RabbitMQ.
  coverageThreshold: {
    global: {
      statements: 97,
      branches: 65,
      functions: 100,
      lines: 97,
    },
  },
};
