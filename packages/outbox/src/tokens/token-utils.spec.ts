import {
  getEventExternalizerToken,
  getEventPublicationProcessorToken,
  getEventPublicationRegistryToken,
  getEventPublicationRepositoryToken,
  getEventTypeRegistryToken,
  getExternalizationRegistryToken,
  getOutboxEventSerializerToken,
  getOutboxListenerRegistryToken,
  getOutboxPublisherToken,
} from './token-utils';

describe('Token utilities (outbox)', () => {
  const allUtilities = [
    {
      name: 'getOutboxPublisherToken',
      fn: getOutboxPublisherToken,
      defaultToken: 'defaultOutboxEventPublisher',
      billingToken: 'billingOutboxEventPublisher',
    },
    {
      name: 'getEventTypeRegistryToken',
      fn: getEventTypeRegistryToken,
      defaultToken: 'defaultEventTypeRegistry',
      billingToken: 'billingEventTypeRegistry',
    },
    {
      name: 'getEventPublicationRegistryToken',
      fn: getEventPublicationRegistryToken,
      defaultToken: 'defaultEventPublicationRegistry',
      billingToken: 'billingEventPublicationRegistry',
    },
    {
      name: 'getEventPublicationProcessorToken',
      fn: getEventPublicationProcessorToken,
      defaultToken: 'defaultEventPublicationProcessor',
      billingToken: 'billingEventPublicationProcessor',
    },
    {
      name: 'getOutboxListenerRegistryToken',
      fn: getOutboxListenerRegistryToken,
      defaultToken: 'defaultOutboxListenerRegistry',
      billingToken: 'billingOutboxListenerRegistry',
    },
    {
      name: 'getExternalizationRegistryToken',
      fn: getExternalizationRegistryToken,
      defaultToken: 'defaultExternalizationRegistry',
      billingToken: 'billingExternalizationRegistry',
    },
    {
      name: 'getEventPublicationRepositoryToken',
      fn: getEventPublicationRepositoryToken,
      defaultToken: 'defaultEventPublicationRepository',
      billingToken: 'billingEventPublicationRepository',
    },
    {
      name: 'getEventExternalizerToken',
      fn: getEventExternalizerToken,
      defaultToken: 'defaultEventExternalizer',
      billingToken: 'billingEventExternalizer',
    },
    {
      name: 'getOutboxEventSerializerToken',
      fn: getOutboxEventSerializerToken,
      defaultToken: 'defaultOutboxEventSerializer',
      billingToken: 'billingOutboxEventSerializer',
    },
  ] as const;

  describe.each(allUtilities)(
    '$name',
    ({ fn, defaultToken, billingToken }) => {
      it('defaults to the "default" dataSource when no argument is passed', () => {
        expect(fn()).toBe(defaultToken);
      });

      it('uses the provided dataSource name', () => {
        expect(fn('billing')).toBe(billingToken);
      });

      it('is deterministic across calls', () => {
        expect(fn('audit')).toBe(fn('audit'));
      });
    },
  );

  describe('cross-token uniqueness', () => {
    it('produces distinct tokens per component for the same dataSource', () => {
      const ds = 'billing';
      const tokens = new Set(allUtilities.map(({ fn }) => fn(ds)));
      expect(tokens.size).toBe(allUtilities.length);
    });

    it('produces distinct tokens per dataSource for the same component', () => {
      const tokens = new Set(
        ['billing', 'inventory', 'audit'].map((ds) => getOutboxPublisherToken(ds)),
      );
      expect(tokens.size).toBe(3);
    });
  });
});
