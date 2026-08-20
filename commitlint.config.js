/**
 * Conventional Commits, as CONTRIBUTING describes them, with three
 * deviations from `@commitlint/config-conventional`. Each one is here
 * because the default would reject commits this repository has
 * legitimately been making.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Default is 100; three headers in this history run to 103-108
    // characters, and they are descriptive rather than rambling
    // ("feat(outbox-typeorm)!: OutboxTypeOrmModule reshape mirroring
    // TypeOrmTransactionalModule.forRoot pattern"). 120 leaves headroom
    // while still bounding a runaway subject.
    'header-max-length': [2, 'always', 120],

    // Off, not relaxed. The default forbids pascal-case and
    // sentence-case subjects, which rejects a subject that opens with an
    // identifier — `ADR-019 — outbox multi-forRoot registration
    // pattern`, `OutboxTypeOrmModule reshape ...`, `AGENTS.md roll-up
    // ...`. A rule that rejects the accurate subject only teaches people
    // to write a vaguer one.
    'subject-case': [0],

    // Off for both: bodies here carry URLs to Spring documentation and
    // occasional inline code, neither of which should be hard-wrapped to
    // satisfy a linter. Prose in bodies is wrapped by hand anyway.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
  // No `scope-enum` on purpose. The history uses 19 distinct scopes,
  // including combined ones (`cqrs,outbox`) and non-package areas
  // (`examples`, `release`, `adr`, `gitignore`). An enum would have to be
  // updated before it could ever reject anything useful, so it would
  // only ever be in the way.
};
