/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  testPathIgnorePatterns: ['\\.integration\\.spec\\.ts$'],
  passWithNoTests: true,
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The `@nestjs-transactional/*` packages ship ESM, so the suites run
  // as ESM too. `moduleNameMapper` maps the explicit `.js` that ESM
  // requires in relative specifiers back to the `.ts` on disk. Needs
  // `NODE_OPTIONS=--experimental-vm-modules`, set in the test scripts.
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/test/tsconfig.json', useESM: true }],
  },
};
