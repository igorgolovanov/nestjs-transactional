/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['reflect-metadata'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The packages publish ESM, so the suites run as ESM too. Three
  // settings are load-bearing and none of them is optional:
  //
  //  - `extensionsToTreatAsEsm` — without it Jest hands `.ts` to the
  //    CommonJS registry and every `import` fails to parse.
  //  - `moduleNameMapper` — ESM requires the explicit `.js` extension in
  //    relative specifiers, but on disk those files are still `.ts`.
  //    This maps the specifier back.
  //  - `useESM` on ts-jest — otherwise it emits CommonJS into an ESM
  //    module scope.
  //
  // Jest also needs `NODE_OPTIONS=--experimental-vm-modules`, which the
  // package `test` scripts set. Running `npx jest` by hand without it
  // fails on the first import.
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        useESM: true,
        // TS151002 is ts-jest warning that hybrid module kinds want
        // `isolatedModules`; the build sets it, and the warning is noise
        // on every suite otherwise.
        diagnostics: { ignoreCodes: ['TS151001', 'TS151002'] },
      },
    ],
  },
  testRegex: '.*\\.spec\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '\\.integration\\.spec\\.ts$'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.integration.spec.ts',
    '!src/**/index.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  clearMocks: true,
  restoreMocks: true,
  verbose: false,
  // No `passWithNoTests` on purpose: a package that ships without unit
  // tests must fail its own `test` script rather than report success.
  // Per-package `coverageThreshold` floors live in each
  // `packages/*/jest.config.js`.
};
