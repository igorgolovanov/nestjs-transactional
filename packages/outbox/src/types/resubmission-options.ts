import type { EventPublication } from './event-publication';

/**
 * Predicate that decides whether a given publication should be included
 * in a resubmission batch.
 */
export type ResubmissionFilter = (publication: EventPublication) => boolean;

/**
 * Builder-style configuration for a resubmission pass.
 *
 * @example
 * ```ts
 * ResubmissionOptions.defaults()
 *   .withBatchSize(50)
 *   .withMaxInFlight(5)
 *   .withMinAge(10_000)
 *   .withMaxAttempts(3);
 * ```
 */
export class ResubmissionOptions {
  private _batchSize = 100;
  private _maxInFlight = 10;
  private _minAge = 0;
  private _maxCompletionAttempts: number | null = null;
  private _filter: ResubmissionFilter | null = null;

  static defaults(): ResubmissionOptions {
    return new ResubmissionOptions();
  }

  withBatchSize(size: number): this {
    this._batchSize = size;
    return this;
  }

  withMaxInFlight(n: number): this {
    this._maxInFlight = n;
    return this;
  }

  withMinAge(ms: number): this {
    this._minAge = ms;
    return this;
  }

  withMaxAttempts(n: number): this {
    this._maxCompletionAttempts = n;
    return this;
  }

  withFilter(filter: ResubmissionFilter): this {
    this._filter = filter;
    return this;
  }

  get batchSize(): number {
    return this._batchSize;
  }

  get maxInFlight(): number {
    return this._maxInFlight;
  }

  get minAge(): number {
    return this._minAge;
  }

  get maxCompletionAttempts(): number | null {
    return this._maxCompletionAttempts;
  }

  get filter(): ResubmissionFilter | null {
    return this._filter;
  }
}
