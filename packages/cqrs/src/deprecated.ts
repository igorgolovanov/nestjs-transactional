import { TransactionalCqrsBootstrap } from './handlers/bootstrap.js';
import { TRANSACTIONAL_CQRS_OPTIONS } from './module/tokens.js';
import {
  type TransactionalCqrsAsyncFactoryResult,
  type TransactionalCqrsAsyncOptions,
  TransactionalCqrsModule,
  type TransactionalCqrsOptions,
} from './module/transactional-cqrs.module.js';

// The 2.x names, kept as aliases so code written against them keeps
// compiling. The public names now lead with `Transactional`, like
// `@nestjs/workflows`' `WorkflowsCqrsModule` leads with its own package
// (DD-030). Removed in the next major.

/** @deprecated Use {@link TransactionalCqrsModule}. */
export const CqrsTransactionalModule = TransactionalCqrsModule;
/** @deprecated Use {@link TransactionalCqrsModule}. */
export type CqrsTransactionalModule = TransactionalCqrsModule;

/** @deprecated Use {@link TransactionalCqrsBootstrap}. */
export const CqrsTransactionalBootstrap = TransactionalCqrsBootstrap;
/** @deprecated Use {@link TransactionalCqrsBootstrap}. */
export type CqrsTransactionalBootstrap = TransactionalCqrsBootstrap;

/** @deprecated Use {@link TRANSACTIONAL_CQRS_OPTIONS}. */
export const CQRS_TRANSACTIONAL_OPTIONS = TRANSACTIONAL_CQRS_OPTIONS;

/** @deprecated Use {@link TransactionalCqrsOptions}. */
export type CqrsTransactionalOptions = TransactionalCqrsOptions;
/** @deprecated Use {@link TransactionalCqrsAsyncOptions}. */
export type CqrsTransactionalAsyncOptions = TransactionalCqrsAsyncOptions;
/** @deprecated Use {@link TransactionalCqrsAsyncFactoryResult}. */
export type CqrsTransactionalAsyncFactoryResult = TransactionalCqrsAsyncFactoryResult;
