import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WorkflowClient } from '@nestjs/workflows';
import { TransactionManager } from '@nestjs-transactional/core';

import { WorkflowClientBinding } from '../binding/workflow-client-binding.js';

import { TRANSACTIONAL_WORKFLOWS_OPTIONS } from './tokens.js';
import { TransactionalWorkflowsModule } from './transactional-workflows.module.js';

const client = {
  start: () => Promise.resolve(),
  signal: () => Promise.resolve(),
  startAndWait: () => Promise.resolve(),
};

@Global()
@Module({
  providers: [
    { provide: WorkflowClient, useValue: client },
    { provide: TransactionManager, useValue: { nativeTransactionOf: () => undefined } },
  ],
  exports: [WorkflowClient, TransactionManager],
})
class FakeWorkflowsModule {}

describe('TransactionalWorkflowsModule', () => {
  it('binds the client and keeps the options', async () => {
    const app = await Test.createTestingModule({
      imports: [
        FakeWorkflowsModule,
        TransactionalWorkflowsModule.forRoot({ dataSource: 'orders' }),
      ],
    }).compile();

    expect(app.get(WorkflowClientBinding)).toBeInstanceOf(WorkflowClientBinding);
    expect(app.get(TRANSACTIONAL_WORKFLOWS_OPTIONS)).toEqual({ dataSource: 'orders' });
    expect(Object.getOwnPropertySymbols(client)).toContain(
      Symbol.for('@nestjs-transactional/workflows/client-wrapped'),
    );
  });

  it('is global, so the binding is built once for the application', () => {
    expect(TransactionalWorkflowsModule.forRoot().global).toBe(true);
  });
});
