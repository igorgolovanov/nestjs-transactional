import { type DynamicModule, Module } from '@nestjs/common';

import {
  type TransactionalWorkflowsOptions,
  WorkflowClientBinding,
} from '../binding/workflow-client-binding.js';

import { TRANSACTIONAL_WORKFLOWS_OPTIONS } from './tokens.js';

/**
 * Makes `@nestjs/workflows` join the transaction `@Transactional` opened:
 * `WorkflowClient.start()` and `signal()` called inside it, directly or
 * through `WorkflowsCqrsModule`'s `@StartOn` and `@SignalOn`, write in
 * that transaction without a `transaction` option (DD-031).
 *
 * `WorkflowsModule` and its store are configured as `@nestjs/workflows`
 * documents them; this module adds only the transactional side.
 *
 * @example
 * ```ts
 * @Module({
 *   imports: [
 *     TransactionalModule.forRoot({ isGlobal: true }),
 *     TransactionalTypeOrmModule.forRoot(),
 *     WorkflowsModule.forRoot(),
 *     TransactionalWorkflowsModule.forRoot(),
 *   ],
 *   providers: [
 *     {
 *       provide: PostgresWorkflowStore,
 *       inject: [DataSource, WorkflowStorage],
 *       useFactory: (dataSource: DataSource, storage: WorkflowStorage) =>
 *         new PostgresWorkflowStore({ executor: fromTypeOrm(dataSource) }, storage),
 *     },
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class TransactionalWorkflowsModule {
  static forRoot(options: TransactionalWorkflowsOptions = {}): DynamicModule {
    return {
      module: TransactionalWorkflowsModule,
      global: true,
      providers: [
        { provide: TRANSACTIONAL_WORKFLOWS_OPTIONS, useValue: options },
        WorkflowClientBinding,
      ],
      exports: [WorkflowClientBinding],
    };
  }
}
