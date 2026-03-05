import 'reflect-metadata';

import {
  InjectEventExternalizer,
  InjectEventPublicationProcessor,
  InjectEventPublicationRegistry,
  InjectEventPublicationRepository,
  InjectEventTypeRegistry,
  InjectExternalizationRegistry,
  InjectOutboxEventSerializer,
  InjectOutboxListenerRegistry,
  InjectOutboxPublisher,
} from './inject-decorators';

function readSelfParamTypes(target: unknown): { index: number; param: unknown }[] {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
  return Reflect.getMetadata('self:paramtypes', target as any) ?? [];
}

const cases = [
  {
    name: 'InjectOutboxPublisher',
    decorator: InjectOutboxPublisher,
    defaultToken: 'defaultOutboxEventPublisher',
    billingToken: 'billingOutboxEventPublisher',
  },
  {
    name: 'InjectEventTypeRegistry',
    decorator: InjectEventTypeRegistry,
    defaultToken: 'defaultEventTypeRegistry',
    billingToken: 'billingEventTypeRegistry',
  },
  {
    name: 'InjectEventPublicationRegistry',
    decorator: InjectEventPublicationRegistry,
    defaultToken: 'defaultEventPublicationRegistry',
    billingToken: 'billingEventPublicationRegistry',
  },
  {
    name: 'InjectEventPublicationProcessor',
    decorator: InjectEventPublicationProcessor,
    defaultToken: 'defaultEventPublicationProcessor',
    billingToken: 'billingEventPublicationProcessor',
  },
  {
    name: 'InjectOutboxListenerRegistry',
    decorator: InjectOutboxListenerRegistry,
    defaultToken: 'defaultOutboxListenerRegistry',
    billingToken: 'billingOutboxListenerRegistry',
  },
  {
    name: 'InjectExternalizationRegistry',
    decorator: InjectExternalizationRegistry,
    defaultToken: 'defaultExternalizationRegistry',
    billingToken: 'billingExternalizationRegistry',
  },
  {
    name: 'InjectEventPublicationRepository',
    decorator: InjectEventPublicationRepository,
    defaultToken: 'defaultEventPublicationRepository',
    billingToken: 'billingEventPublicationRepository',
  },
  {
    name: 'InjectEventExternalizer',
    decorator: InjectEventExternalizer,
    defaultToken: 'defaultEventExternalizer',
    billingToken: 'billingEventExternalizer',
  },
  {
    name: 'InjectOutboxEventSerializer',
    decorator: InjectOutboxEventSerializer,
    defaultToken: 'defaultOutboxEventSerializer',
    billingToken: 'billingOutboxEventSerializer',
  },
] as const;

describe('Inject decorators (outbox)', () => {
  describe.each(cases)(
    '$name',
    ({ decorator, defaultToken, billingToken }) => {
      it('binds the default-dataSource token when no argument is passed', () => {
        class TestClass {
          constructor(
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            @decorator() readonly dep: unknown,
          ) {}
        }
        expect(readSelfParamTypes(TestClass)[0]!.param).toBe(defaultToken);
      });

      it('binds the supplied-dataSource token', () => {
        class TestClass {
          constructor(
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            @decorator('billing') readonly dep: unknown,
          ) {}
        }
        expect(readSelfParamTypes(TestClass)[0]!.param).toBe(billingToken);
      });
    },
  );
});
