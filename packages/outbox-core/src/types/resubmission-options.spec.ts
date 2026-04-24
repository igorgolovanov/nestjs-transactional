import { ResubmissionOptions } from './resubmission-options';

describe('ResubmissionOptions', () => {
  describe('defaults()', () => {
    it('returns a fresh instance with sensible defaults', () => {
      const opts = ResubmissionOptions.defaults();

      expect(opts.batchSize).toBe(100);
      expect(opts.maxInFlight).toBe(10);
      expect(opts.minAge).toBe(0);
      expect(opts.maxCompletionAttempts).toBeNull();
      expect(opts.filter).toBeNull();
    });

    it('returns independent instances on each call', () => {
      const a = ResubmissionOptions.defaults().withBatchSize(10);
      const b = ResubmissionOptions.defaults();

      expect(a.batchSize).toBe(10);
      expect(b.batchSize).toBe(100);
    });
  });

  describe('builder methods', () => {
    it('withBatchSize returns the same instance and updates the value', () => {
      const opts = ResubmissionOptions.defaults();
      const returned = opts.withBatchSize(50);

      expect(returned).toBe(opts);
      expect(opts.batchSize).toBe(50);
    });

    it('withMaxInFlight returns the same instance and updates the value', () => {
      const opts = ResubmissionOptions.defaults();
      const returned = opts.withMaxInFlight(3);

      expect(returned).toBe(opts);
      expect(opts.maxInFlight).toBe(3);
    });

    it('withMinAge returns the same instance and updates the value', () => {
      const opts = ResubmissionOptions.defaults();
      const returned = opts.withMinAge(5_000);

      expect(returned).toBe(opts);
      expect(opts.minAge).toBe(5_000);
    });

    it('withMaxAttempts returns the same instance and updates the value', () => {
      const opts = ResubmissionOptions.defaults();
      const returned = opts.withMaxAttempts(5);

      expect(returned).toBe(opts);
      expect(opts.maxCompletionAttempts).toBe(5);
    });

    it('withFilter returns the same instance and stores the predicate', () => {
      const opts = ResubmissionOptions.defaults();
      const filter = jest.fn().mockReturnValue(true);
      const returned = opts.withFilter(filter);

      expect(returned).toBe(opts);
      expect(opts.filter).toBe(filter);
    });

    it('supports fluent chaining of all builder methods', () => {
      const filter = jest.fn().mockReturnValue(true);
      const opts = ResubmissionOptions.defaults()
        .withBatchSize(25)
        .withMaxInFlight(2)
        .withMinAge(1_000)
        .withMaxAttempts(4)
        .withFilter(filter);

      expect(opts.batchSize).toBe(25);
      expect(opts.maxInFlight).toBe(2);
      expect(opts.minAge).toBe(1_000);
      expect(opts.maxCompletionAttempts).toBe(4);
      expect(opts.filter).toBe(filter);
    });
  });
});
