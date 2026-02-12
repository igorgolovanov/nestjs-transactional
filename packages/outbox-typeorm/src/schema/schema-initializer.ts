import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import {
  EVENT_PUBLICATION_TABLE,
  applyEventPublicationSchema,
} from './event-publication-schema';
import type { SchemaInitializationOptions } from './schema-initialization-options';

interface ExistsRow {
  readonly exists: string | null;
}

/**
 * Development-time helper that creates the `event_publication` schema
 * at application bootstrap, so developers can spin up a fresh app
 * against an empty database without a separate migration step.
 *
 * **Not intended for production.** Production deployments should apply
 * the schema via the TypeORM migration shipped by this package
 * (`CreateEventPublication1700000000000`) or their own equivalent,
 * and leave `enabled: false`.
 *
 * The equivalent Spring Modulith switch is
 * `spring.modulith.events.jdbc.schema-initialization.enabled`.
 */
@Injectable()
export class SchemaInitializer implements OnApplicationBootstrap {
  private readonly logger = new Logger(SchemaInitializer.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly options: SchemaInitializationOptions,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.enabled) {
      return;
    }

    if (await this.hotTableExists()) {
      this.logger.debug(
        `Table '${EVENT_PUBLICATION_TABLE}' already exists — skipping auto schema init`,
      );
      return;
    }

    this.logger.log(
      `Initialising '${EVENT_PUBLICATION_TABLE}' schema (development auto-init)`,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await applyEventPublicationSchema(queryRunner);
      this.logger.log(`'${EVENT_PUBLICATION_TABLE}' schema initialised`);
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Check for the hot table via `to_regclass` — Postgres-specific and
   * respects the current `search_path`. Returns `null` when the table
   * is missing, a regclass name (as text after the `::text` cast) when
   * it exists.
   */
  private async hotTableExists(): Promise<boolean> {
    const rows = await this.dataSource.query<ExistsRow[]>(
      `SELECT to_regclass($1)::text AS exists`,
      [EVENT_PUBLICATION_TABLE],
    );
    return rows[0]?.exists != null;
  }
}
