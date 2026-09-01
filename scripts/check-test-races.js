#!/usr/bin/env node
//
// Fail when an integration spec waits for an in-memory signal and then
// asserts a publication's status in the database.
//
// The outbox worker appends to a handler's `handled` array, or calls a
// mocked broker's `emit`, from inside the dispatch. It writes the row's
// terminal status only after that call returns. So a test that waits on
// the flag or on the emit mock and then asserts `COMPLETED` is asserting
// across a window it never waited for. The window is invisible on a
// developer machine and real on a loaded CI runner.
//
// This is not hypothetical. It has cost three separate debugging
// sessions:
//   - `examples/basic-typeorm-outbox`, which broke `main` after an
//     unrelated NestJS bump merely shifted the timing;
//   - `examples/async-config-from-environment`, found during an earlier
//     sweep;
//   - `examples/externalization-multi-broker`, which this check found
//     while it was being written, before it had failed anywhere.
//
// The fix in every case is the same: wait on the rows, not on the
// signal. Reaching a terminal status implies the handler ran and the
// broker was emitted to, so the flag assertions lose nothing by moving
// after the wait.
//
// What counts as waiting on the rows:
//   - `waitForPublications(...)`, the helper the specs share;
//   - any `waitFor(async ...)`, since an async predicate is how a spec
//     reads the database inside a wait;
//   - `await module.close()` / `await app.close()`, because shutdown
//     drains in-flight work before returning, which makes the status
//     final by contract. `examples/graceful-shutdown` depends on this
//     and is correct.
//
// Scope and limits:
//   - Only `*.integration.spec.ts` is scanned. Unit specs drive a mocked
//     repository synchronously and have no worker to race.
//   - Only flags a block that waits on a non-database signal. A spec
//     that drives the worker with an awaited call it made itself, such
//     as `await processor.processBatch()` or `await repo.tryClaim(...)`,
//     is deterministic and is deliberately not flagged. An earlier draft
//     that flagged every status assertion without a database wait
//     produced 22 hits, 20 of them false, which is how a gate gets
//     switched off rather than fixed.
//   - Line-based, not a parser. It can miss an unusual formatting of the
//     same mistake. It is a floor, not a proof.
//
// Deliberately dependency-free: plain Node over `git ls-files`, so it
// runs identically in CI and locally with nothing to install.

'use strict';

const fs = require('node:fs');
const { execSync } = require('node:child_process');

const STATUS = /PublicationStatus\.(COMPLETED|FAILED|PROCESSING|PUBLISHED)/;
const ASSERTION = /expect\(|toBe\(|toEqual\(|toMatchObject\(/;
const IT_BLOCK = /^\s*it(\.each\(.*\))?\(/;
const WAIT_CALL = /await\s+waitFor\(/;
const READS_DB = /getRepository|waitForPublications|\.query\(|find\(\)|findOne/;
const DB_WAIT = /waitForPublications\(|await\s+waitFor\(\s*async/;
const SHUTDOWN = /await\s+(module|app|moduleRef)\.close\(\)/;

/** Where the `it` blocks start, so a block can be read in isolation. */
function blockRanges(lines) {
  const starts = [];
  lines.forEach((line, i) => {
    if (IT_BLOCK.test(line)) starts.push(i);
  });
  return starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? starts[i + 1] : lines.length,
  }));
}

/**
 * True when the lines contain a `waitFor` whose predicate never touches
 * the database, i.e. a wait on a handler flag or on a mock.
 */
function waitsOnMemoryOnly(lines) {
  return lines.some((line, i) => {
    if (!WAIT_CALL.test(line)) return false;
    // The predicate can span several lines; six is well past every
    // multi-condition wait currently in the tree.
    return !READS_DB.test(lines.slice(i, i + 6).join('\n'));
  });
}

function findings() {
  const files = execSync('git ls-files', { encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.integration.spec.ts'));

  const out = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const { start, end } of blockRanges(lines)) {
      const block = lines.slice(start, end);
      block.forEach((line, i) => {
        if (!STATUS.test(line) || !ASSERTION.test(line)) return;
        const before = block.slice(0, i);
        const beforeText = before.join('\n');
        if (DB_WAIT.test(beforeText) || SHUTDOWN.test(beforeText)) return;
        if (!waitsOnMemoryOnly(before)) return;
        out.push({ file, line: start + i + 1, text: line.trim() });
      });
    }
  }
  return out;
}

const hits = findings();

if (hits.length === 0) {
  console.log('No status assertion waits on an in-memory signal instead of the rows.');
  process.exit(0);
}

console.error('Status asserted after waiting on an in-memory signal, not on the rows:\n');
for (const hit of hits) {
  console.error(`  ${hit.file}:${hit.line}`);
  console.error(`      ${hit.text}\n`);
}
console.error(
  'The worker writes the terminal status after the handler returns and, where\n' +
    'externalization is configured, after the broker emit returns. Waiting on a\n' +
    'handler flag or an emit mock does not wait for that write.\n\n' +
    'Wait on the rows instead, with `waitForPublications(...)`, and move the flag\n' +
    'assertions after it: a row cannot reach a terminal status without its\n' +
    'handler having returned first.',
);
process.exit(1);
