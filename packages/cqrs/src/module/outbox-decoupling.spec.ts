import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { OUTBOX_PUBLICATION_SCHEDULER } from '../event-publisher/outbox-publication-scheduler.js';

function collectTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? collectTsFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/**
 * cqrs reaches the outbox through one structural port,
 * `OUTBOX_PUBLICATION_SCHEDULER`, and never through an import. That is
 * what lets `@nestjs-transactional/outbox` bind the port without either
 * package depending on the other.
 */
describe('cqrs and the outbox stay decoupled', () => {
  it('cqrs source imports nothing from @nestjs-transactional/outbox', () => {
    // `import.meta.dirname` rather than `__dirname`: the package is ESM.
    const offenders = collectTsFiles(join(import.meta.dirname, '..'))
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes("from '@nestjs-transactional/outbox'"));

    expect(offenders).toEqual([]);
  });

  it('the scheduler port is a Symbol.for key the outbox package can bind', () => {
    expect(OUTBOX_PUBLICATION_SCHEDULER).toBe(
      Symbol.for('@nestjs-transactional/cqrs/outbox-publication-scheduler'),
    );
  });
});
