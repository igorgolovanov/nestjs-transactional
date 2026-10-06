import { entityKind } from 'drizzle-orm';

import { createTestDb, type TestDb } from '../support/pglite.js';

/**
 * Contract tests for the Drizzle internals the instance patch depends on.
 *
 * `src/patching/drizzle-instance-patch.ts` makes a `drizzle()` database
 * route its calls to the ambient transaction by wrapping, on the
 * instance, every method its prototype chain has and the relational
 * `query` objects it carries. Its failure mode is silent: if Drizzle
 * moves one of these, the patch stops taking effect and that call runs
 * outside the transaction, with nothing throwing.
 *
 * So this file asserts the substrate directly, through `drizzle-orm`
 * and the test database only, never our own modules. When one fails
 * after a version bump, revisit the patch. The CI matrix runs it on
 * every supported Drizzle line.
 */
describe('Drizzle internals contract (instance patch)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.$client.close();
  });

  const kindsOf = (value: object): string[] => {
    const kinds: string[] = [];
    for (
      let type = value.constructor;
      typeof type === 'function';
      type = Object.getPrototypeOf(type)
    ) {
      const kind = (type as unknown as Record<symbol, unknown>)[entityKind];
      if (typeof kind === 'string') {
        kinds.push(kind);
      }
    }
    return kinds;
  };

  const methodsOnPrototypes = (value: object): Set<string> => {
    const names = new Set<string>();
    for (
      let proto = Object.getPrototypeOf(value);
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (
          name !== 'constructor' &&
          typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function'
        ) {
          names.add(name);
        }
      }
    }
    return names;
  };

  it('marks a PostgreSQL database with a Pg*Database entity kind', () => {
    // The adapter reads the dialect from here, and @nestjs/store-kit's
    // fromDrizzle() recognises a database the same way.
    expect(kindsOf(db).some((kind) => /^Pg\w*Database$/.test(kind))).toBe(true);
  });

  it('keeps the query builders as methods on the prototype chain', () => {
    // The patch wraps every prototype method, so a new one is covered;
    // these are the ones applications use and the suite exercises.
    const methods = methodsOnPrototypes(db);
    for (const name of [
      'select',
      'insert',
      'update',
      'delete',
      'execute',
      'transaction',
      '$count',
      'with',
    ]) {
      expect(methods).toContain(name);
    }
  });

  it('keeps no method of the prototype chain as an own property of the instance', () => {
    // An own property would shadow the wrapper the patch installs.
    for (const name of methodsOnPrototypes(db)) {
      expect(Object.getOwnPropertyDescriptor(db, name)).toBeUndefined();
    }
  });

  it('carries query and $with as plain data properties of the instance', () => {
    // The patch replaces these with getters; an accessor here would mean
    // Drizzle computes them, and the patch would need to follow.
    for (const name of ['query', '$with']) {
      const descriptor = Object.getOwnPropertyDescriptor(db, name);
      expect(descriptor).toMatchObject({ writable: true, configurable: true });
      expect(descriptor).not.toHaveProperty('get');
    }
  });

  it("hands transaction() callbacks a Pg*Transaction that has the database's surface", async () => {
    await db.transaction(async (tx) => {
      expect(kindsOf(tx).some((kind) => /^Pg\w*Transaction$/.test(kind))).toBe(true);
      expect(tx).toBeInstanceOf(Object.getPrototypeOf(Object.getPrototypeOf(db)).constructor);
      for (const name of methodsOnPrototypes(db)) {
        expect(typeof (tx as unknown as Record<string, unknown>)[name]).toBe('function');
      }
      expect(tx.query).toBeDefined();
    });
  });
});
