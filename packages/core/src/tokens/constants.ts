/**
 * Default dataSource name used when none is specified to a token
 * utility or inject decorator. Single-adapter consumers never need to
 * type this string — the default argument on every helper substitutes
 * it automatically.
 *
 * Multi-adapter consumers register additional dataSources by name
 * (`'billing'`, `'inventory'`, ...). The string `'default'` is the
 * convention for the always-present primary registration; ADR-018
 * documents why this fixed name was chosen over alternatives like
 * `'main'` or `'primary'`.
 */
export const DEFAULT_DATA_SOURCE_NAME = 'default';
