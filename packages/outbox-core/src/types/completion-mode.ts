/**
 * Behavior when a publication is successfully completed.
 *
 * - `UPDATE`: set `completion_date` on the record (default). Keeps the
 *   row for inspection of completed publications; requires manual
 *   purging eventually.
 * - `DELETE`: delete the record. No audit of completed publications.
 * - `ARCHIVE`: move the record to an archive table, keeping it for
 *   inspection without weighing down the hot queue.
 */
export enum CompletionMode {
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  ARCHIVE = 'ARCHIVE',
}
