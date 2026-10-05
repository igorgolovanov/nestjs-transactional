/**
 * DI token for the resolved `CqrsTransactionalOptions` object.
 * Consumers normally do not inject this directly: the module's providers
 * read it.
 */
export const CQRS_TRANSACTIONAL_OPTIONS = 'CQRS_TRANSACTIONAL_OPTIONS';
