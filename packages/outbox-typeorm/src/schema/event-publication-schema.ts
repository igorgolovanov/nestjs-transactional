import { PublicationStatus } from '@nestjs-transactional/outbox';
import { Table, TableIndex, type QueryRunner } from 'typeorm';

/**
 * Canonical table name for the hot queue. Exposed so downstream tools
 * (e.g. custom queries, observability) can avoid hardcoding the string.
 */
export const EVENT_PUBLICATION_TABLE = 'event_publication';

/**
 * Canonical table name for the archive trail. Used only by the
 * `ARCHIVE` completion mode.
 */
export const EVENT_PUBLICATION_ARCHIVE_TABLE = 'event_publication_archive';

function buildHotTable(): Table {
  return new Table({
    name: EVENT_PUBLICATION_TABLE,
    columns: [
      { name: 'id', type: 'uuid', isPrimary: true },
      { name: 'listener_id', type: 'varchar', length: '512', isNullable: false },
      { name: 'event_type', type: 'varchar', length: '256', isNullable: false },
      { name: 'serialized_event', type: 'text', isNullable: false },
      { name: 'publication_date', type: 'timestamptz', isNullable: false },
      {
        name: 'status',
        type: 'varchar',
        length: '32',
        default: `'${PublicationStatus.PUBLISHED}'`,
        isNullable: false,
      },
      { name: 'completion_date', type: 'timestamptz', isNullable: true },
      { name: 'last_resubmission_date', type: 'timestamptz', isNullable: true },
      { name: 'completion_attempts', type: 'int', default: 0, isNullable: false },
      { name: 'failure_reason', type: 'text', isNullable: true },
    ],
  });
}

function buildArchiveTable(): Table {
  return new Table({
    name: EVENT_PUBLICATION_ARCHIVE_TABLE,
    columns: [
      { name: 'id', type: 'uuid', isPrimary: true },
      { name: 'listener_id', type: 'varchar', length: '512', isNullable: false },
      { name: 'event_type', type: 'varchar', length: '256', isNullable: false },
      { name: 'serialized_event', type: 'text', isNullable: false },
      { name: 'publication_date', type: 'timestamptz', isNullable: false },
      { name: 'status', type: 'varchar', length: '32', isNullable: false },
      { name: 'completion_date', type: 'timestamptz', isNullable: false },
      { name: 'last_resubmission_date', type: 'timestamptz', isNullable: true },
      { name: 'completion_attempts', type: 'int', isNullable: false },
      { name: 'failure_reason', type: 'text', isNullable: true },
    ],
  });
}

function buildHotIndexes(): TableIndex[] {
  return [
    new TableIndex({
      name: 'idx_event_publication_status_date',
      columnNames: ['status', 'publication_date'],
    }),
    new TableIndex({
      name: 'idx_event_publication_status_listener',
      columnNames: ['status', 'listener_id'],
    }),
    new TableIndex({
      name: 'idx_event_publication_event_type',
      columnNames: ['event_type'],
    }),
    new TableIndex({
      name: 'idx_event_publication_completion_date',
      columnNames: ['completion_date'],
    }),
  ];
}

function buildArchiveIndexes(): TableIndex[] {
  return [
    new TableIndex({
      name: 'idx_event_publication_archive_completion_date',
      columnNames: ['completion_date'],
    }),
    new TableIndex({
      name: 'idx_event_publication_archive_listener',
      columnNames: ['listener_id'],
    }),
    new TableIndex({
      name: 'idx_event_publication_archive_event_type',
      columnNames: ['event_type'],
    }),
  ];
}

/**
 * Create the hot and archive tables plus every index. Shared by
 * {@link CreateEventPublication1700000000000} (the TypeORM migration)
 * and `SchemaInitializer` (development-only auto-init) so the two paths
 * cannot drift.
 *
 * Strict mode: fails if the tables already exist — callers are
 * responsible for checking existence and skipping this call when
 * needed.
 */
export async function applyEventPublicationSchema(qr: QueryRunner): Promise<void> {
  await qr.createTable(buildHotTable());
  for (const index of buildHotIndexes()) {
    await qr.createIndex(EVENT_PUBLICATION_TABLE, index);
  }

  await qr.createTable(buildArchiveTable());
  for (const index of buildArchiveIndexes()) {
    await qr.createIndex(EVENT_PUBLICATION_ARCHIVE_TABLE, index);
  }
}

/**
 * Drop the archive first (to avoid referential surprises if a future
 * revision adds a FK between the two) and then the hot table. Both
 * drops are tolerant — `dropTable(..., true)` adds `IF EXISTS`, so
 * running `down()` on a partially-applied schema still succeeds.
 */
export async function revertEventPublicationSchema(qr: QueryRunner): Promise<void> {
  await qr.dropTable(EVENT_PUBLICATION_ARCHIVE_TABLE, true);
  await qr.dropTable(EVENT_PUBLICATION_TABLE, true);
}
