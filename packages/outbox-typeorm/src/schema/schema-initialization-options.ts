/**
 * Configuration for {@link SchemaInitializer}. Deliberately minimal —
 * the initializer's sole job is to decide whether to create the
 * `event_publication` schema at bootstrap time.
 */
export interface SchemaInitializationOptions {
  /**
   * When `true`, the initializer creates the `event_publication` and
   * `event_publication_archive` tables on application bootstrap if
   * they are missing. When `false` (the default), bootstrap is a
   * no-op and the user is expected to have applied the TypeORM
   * migration shipped by this package (or their own equivalent).
   *
   * **Development only.** Production systems should apply schema
   * changes through a reviewed migration step, never at process
   * startup.
   */
  readonly enabled: boolean;
}

/** DI token for {@link SchemaInitializationOptions}. */
export const SCHEMA_INITIALIZATION_OPTIONS = Symbol('SCHEMA_INITIALIZATION_OPTIONS');

/** Safe defaults — auto-init off, migrations preferred. */
export const DEFAULT_SCHEMA_INITIALIZATION_OPTIONS: SchemaInitializationOptions = {
  enabled: false,
};
