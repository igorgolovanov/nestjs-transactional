/* eslint-disable @typescript-eslint/no-unsafe-function-type */

import { TransactionContext } from '@nestjs-transactional/core';

import type {
  DrizzleDatabaseLike,
  DrizzleTransactionHandle,
} from '../types/drizzle-transaction-handle.js';

/** Set on a patched database: the methods it had before the patch. */
const ORIGINALS = Symbol.for('@nestjs-transactional/drizzle:originals');

/**
 * The instance properties that are per-database objects, not methods:
 * the relational query API (`query`, and 1.0's `_query` for the v1 API)
 * and `$with`. While a transaction is active they read from its `tx`.
 */
const ROUTED_PROPERTIES = ['query', '_query', '$with'] as const;

/** Which dataSource each managed database is registered as. */
let managed = new WeakMap<object, string>();

/** The `tx` of the transaction active on `dataSourceName`, if any. */
function activeTx(dataSourceName: string): DrizzleDatabaseLike | undefined {
  const active = TransactionContext.getActiveTransaction(`drizzle:${dataSourceName}`);
  return (active?.handle as DrizzleTransactionHandle | undefined)?.tx;
}

/** Where a call on `db` goes: the active transaction's `tx`, or `db` itself. */
function targetOf(db: object): object {
  const name = managed.get(db);
  return (name !== undefined ? activeTx(name) : undefined) ?? db;
}

/**
 * Makes `db` follow `@Transactional`: while a transaction is active on
 * `dataSourceName`, a call on `db` runs on that transaction's `tx`;
 * otherwise on `db`, as before.
 *
 * Every method `db` has through its prototype chain gets an own-property
 * wrapper that picks the target at call time, so the builders
 * (`select`, `insert`, `update`, `delete`, `execute`, `$count`, `with`...)
 * and `transaction` itself, which inside a transaction becomes Drizzle's
 * nested transaction, a savepoint. The relational `query` objects and
 * `$with` become getters. The prototypes are not touched, so a `tx`,
 * which shares them, is not affected.
 *
 * Applied once per instance; a second call with the same name is a
 * no-op, and with another name an error, since one database cannot be
 * two dataSources.
 */
export function patchDrizzleInstance(db: object, dataSourceName: string): void {
  const registered = managed.get(db);
  if (registered !== undefined && registered !== dataSourceName) {
    throw new TypeError(
      `This Drizzle database is already registered as dataSource '${registered}'; ` +
        `it cannot also be '${dataSourceName}'. Give each dataSource its own drizzle() instance.`,
    );
  }
  managed.set(db, dataSourceName);

  const target = db as Record<PropertyKey, unknown>;
  if (target[ORIGINALS] !== undefined) {
    return;
  }

  const originals: Record<string, Function> = {};
  for (
    let proto: object | null = Object.getPrototypeOf(db) as object | null;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (name === 'constructor' || name in originals || typeof descriptor?.value !== 'function') {
        continue;
      }
      const original = descriptor.value as Function;
      originals[name] = original;
      Object.defineProperty(db, name, {
        configurable: true,
        writable: true,
        value: function routed(this: unknown, ...args: unknown[]): unknown {
          const to = targetOf(db);
          return to === db
            ? Reflect.apply(original, db, args)
            : Reflect.apply(Reflect.get(to, name) as Function, to, args);
        },
      });
    }
  }

  for (const name of ROUTED_PROPERTIES) {
    const descriptor = Object.getOwnPropertyDescriptor(db, name);
    if (descriptor === undefined || !('value' in descriptor)) {
      continue;
    }
    let own: unknown = descriptor.value;
    Object.defineProperty(db, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get(): unknown {
        const to = targetOf(db);
        return to === db ? own : (to as Record<string, unknown>)[name];
      },
      set(value: unknown): void {
        own = value;
      },
    });
  }

  Object.defineProperty(db, ORIGINALS, { value: originals });
}

/** `db`'s `transaction` method from before the patch, if it was patched. */
export function originalTransactionOf(db: object): DrizzleDatabaseLike['transaction'] | undefined {
  const originals = (db as Record<PropertyKey, unknown>)[ORIGINALS] as
    Record<string, DrizzleDatabaseLike['transaction']> | undefined;
  return originals?.transaction;
}

/** The dataSource `db` is registered as, if any. */
export function managedDataSourceOf(db: object): string | undefined {
  return managed.get(db);
}

/**
 * Forgets every registration. The wrappers stay on the instances but
 * route nowhere, so a database behaves as unpatched until it is
 * registered again.
 */
export function resetDrizzlePatchingForTesting(): void {
  managed = new WeakMap();
}
