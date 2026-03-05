import { Inject } from '@nestjs/common';

import { DEFAULT_DATA_SOURCE_NAME } from '../tokens/constants';
import {
  getTransactionContextToken,
  getTransactionManagerToken,
  getTransactionalAdapterToken,
} from '../tokens/token-utils';

/**
 * Inject the per-dataSource `TransactionManager`. Sugar over
 * `@Inject(getTransactionManagerToken(dataSource))` for IDE
 * discoverability — matches `@nestjs/typeorm`'s
 * `@InjectRepository(Entity, dataSource?)` ergonomics (DD-022).
 *
 * Default `dataSource` is `'default'`, so single-adapter consumers
 * write `@InjectTransactionManager()` exactly where they would have
 * written `@Inject(TransactionManager)` before.
 *
 * @example
 * ```ts
 * class BillingService {
 *   constructor(
 *     @InjectTransactionManager()
 *     private readonly txManager: TransactionManager,
 *     @InjectTransactionManager('billing')
 *     private readonly billingTxManager: TransactionManager,
 *   ) {}
 * }
 * ```
 */
export const InjectTransactionManager = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getTransactionManagerToken(dataSource));

/**
 * Inject the per-dataSource `TransactionContext`. See
 * {@link InjectTransactionManager} for ergonomics.
 */
export const InjectTransactionContext = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getTransactionContextToken(dataSource));

/**
 * Inject the per-dataSource `TransactionAdapter` instance. Useful
 * for advanced consumers that need to call adapter-specific methods
 * not exposed through `TransactionManager`. See
 * {@link InjectTransactionManager} for ergonomics.
 */
export const InjectTransactionalAdapter = (
  dataSource: string = DEFAULT_DATA_SOURCE_NAME,
): ParameterDecorator => Inject(getTransactionalAdapterToken(dataSource));
