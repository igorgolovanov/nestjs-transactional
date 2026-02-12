import type { MigrationInterface, QueryRunner } from 'typeorm';

import {
  applyEventPublicationSchema,
  revertEventPublicationSchema,
} from '../schema/event-publication-schema';

/**
 * Initial schema for the Event Publication Registry. Creates both the
 * hot queue (`event_publication`) and the archive table
 * (`event_publication_archive`), along with the indexes needed by the
 * worker, operator queries, and the cleanup routines.
 *
 * The timestamp `1700000000000` is a placeholder chosen so this
 * migration sorts before any application-owned migrations a user might
 * add in their project. Teams integrating the package can copy the
 * file into their own migrations directory and rename it to match
 * their migration timestamp convention.
 */
export class CreateEventPublication1700000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await applyEventPublicationSchema(queryRunner);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await revertEventPublicationSchema(queryRunner);
  }
}
