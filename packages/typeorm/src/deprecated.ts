import {
  type TransactionalTypeOrmAsyncOptions,
  TransactionalTypeOrmModule,
  type TransactionalTypeOrmOptions,
} from './module/transactional-typeorm.module.js';

// The 2.x names, kept as aliases so code written against them keeps
// compiling. The public names now lead with `Transactional`, like
// `@nestjs/workflows`' `WorkflowsCqrsModule` leads with its own package
// (DD-030). Removed in the next major.

/** @deprecated Use {@link TransactionalTypeOrmModule}. */
export const TypeOrmTransactionalModule = TransactionalTypeOrmModule;
/** @deprecated Use {@link TransactionalTypeOrmModule}. */
export type TypeOrmTransactionalModule = TransactionalTypeOrmModule;

/** @deprecated Use {@link TransactionalTypeOrmOptions}. */
export type TypeOrmTransactionalOptions = TransactionalTypeOrmOptions;
/** @deprecated Use {@link TransactionalTypeOrmAsyncOptions}. */
export type TypeOrmTransactionalAsyncOptions = TransactionalTypeOrmAsyncOptions;
