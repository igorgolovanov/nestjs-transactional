import { DataSource, EntityManager, Repository } from 'typeorm';

import { TestUser } from '../shared/test-user.entity';

/**
 * Contract tests for the TypeORM internals the patching layer depends on.
 *
 * `packages/typeorm/src/patching/*` reaches past TypeORM's public API to
 * make `@InjectRepository` repositories transparently join the ambient
 * `@Transactional()` scope. That machinery is the least type-safe part of
 * this monorepo (it is where nearly every `any` in the package lives),
 * and its failure mode is the dangerous kind: if TypeORM changes one of
 * these shapes, the patch stops taking effect and every repository call
 * quietly runs on its own autocommit connection instead of the
 * transaction. Nothing throws. Tests that assert on business behaviour
 * would still pass against a single connection.
 *
 * So this file asserts the substrate directly. It imports ONLY `typeorm`
 * — never our own modules, which install the patches as an import side
 * effect (convention #12) — so every assertion below describes stock
 * TypeORM. When one fails after a version bump, the message names the
 * file that has to be revisited.
 *
 * The CI matrix runs the suite against both supported TypeORM majors, so
 * a break shows up per-version rather than as a mystery on upgrade.
 */
describe('TypeORM internals contract (patching layer)', () => {
  it('leaves `Repository.prototype.manager` undefined so the patch can define it', () => {
    // `repository-patches.ts` installs a getter/setter pair here. If
    // TypeORM ever ships its own accessor, ours would silently replace
    // semantics we do not control.
    const descriptor = Object.getOwnPropertyDescriptor(Repository.prototype, 'manager');

    expect(descriptor).toBeUndefined();
  });

  it('assigns `manager` in the constructor by plain assignment, not defineProperty', () => {
    // THE load-bearing assumption of `repository-patches.ts`. A plain
    // `this.manager = manager` routes through a prototype setter and
    // creates no own property, which is what lets the patched getter
    // stay in control. A native class field or an
    // `Object.defineProperty(this, ...)` would instead create an own
    // property that shadows the getter — transparent repositories would
    // stop working with no error anywhere.
    const seen: unknown[] = [];
    const stash = Symbol('probe');

    Object.defineProperty(Repository.prototype, 'manager', {
      configurable: true,
      get(this: Record<symbol, unknown>) {
        return this[stash];
      },
      set(this: Record<symbol, unknown>, value: unknown) {
        seen.push(value);
        this[stash] = value;
      },
    });

    try {
      const fakeManager = { marker: 'from-ctor' } as unknown as EntityManager;
      const repo = new Repository(TestUser, fakeManager, undefined);

      expect(seen).toEqual([fakeManager]);
      // No own property: the prototype accessor remains authoritative.
      expect(Object.getOwnPropertyDescriptor(repo, 'manager')).toBeUndefined();
      expect(repo.manager).toBe(fakeManager);
    } finally {
      delete (Repository.prototype as unknown as Record<string, unknown>).manager;
    }
  });

  it('routes repository data methods through `this.manager` with the entity target', () => {
    // `repository-patches.ts` relies on this indirection: swapping what
    // `this.manager` resolves to is enough to redirect every data method.
    // If TypeORM inlined the connection or captured the manager in the
    // constructor closure, patching `manager` would no longer redirect
    // anything.
    const calls: { method: string; target: unknown }[] = [];
    const recordingManager = {
      save: (target: unknown) => {
        calls.push({ method: 'save', target });
        return Promise.resolve();
      },
      find: (target: unknown) => {
        calls.push({ method: 'find', target });
        return Promise.resolve([]);
      },
      delete: (target: unknown) => {
        calls.push({ method: 'delete', target });
        return Promise.resolve({ affected: 0 });
      },
    } as unknown as EntityManager;

    const repo = new Repository(TestUser, recordingManager, undefined);
    // `metadata` is normally derived from the DataSource; the data
    // methods only read `this.metadata.target`, so a stub suffices.
    Object.defineProperty(repo, 'metadata', {
      configurable: true,
      value: { target: TestUser },
    });

    void repo.save({ name: 'x' });
    void repo.find();
    void repo.delete('id');

    expect(calls.map((c) => c.method)).toEqual(['save', 'find', 'delete']);
    expect(calls.every((c) => c.target === TestUser)).toBe(true);
  });

  it('exposes `getRepository` on `EntityManager.prototype`', () => {
    // `entity-manager-patches.ts` wraps the prototype method so that
    // `em.getRepository(E)` inside a transaction yields a repository
    // bound to the active manager. An own-instance method would escape
    // the wrap.
    expect(typeof EntityManager.prototype.getRepository).toBe('function');
    expect(Object.getOwnPropertyDescriptor(EntityManager.prototype, 'getRepository')).toBeDefined();
  });

  it('exposes `extend` on `Repository.prototype` and builds the child through the constructor', () => {
    // `repository-patches.ts` wraps `extend` because a custom repository
    // created from a patched parent would otherwise observe
    // `this.manager === undefined`. The wrap assumes the child is a
    // fresh instance built by the same constructor path.
    expect(typeof Repository.prototype.extend).toBe('function');

    const manager = { marker: 'extend-probe' } as unknown as EntityManager;
    const parent = new Repository(TestUser, manager, undefined);

    const child = parent.extend({
      custom(): string {
        return 'ok';
      },
    });

    expect(child).toBeInstanceOf(Repository);
    expect(child).not.toBe(parent);
    expect(child.manager).toBe(manager);
    expect(child.custom()).toBe('ok');
  });

  describe('with a live DataSource', () => {
    let ds: DataSource;

    beforeEach(async () => {
      ds = new DataSource({ type: 'sqljs', synchronize: true, entities: [TestUser] });
      await ds.initialize();
    });

    afterEach(async () => {
      await ds.destroy();
    });

    it('keeps `manager` an own property of the DataSource instance', () => {
      // `data-source-patches.ts` patches the INSTANCE rather than
      // `DataSource.prototype` precisely because TypeORM sets `manager`
      // per instance — a prototype patch would be shadowed. If this
      // moves to the prototype, that file's strategy has to change.
      expect(Object.getOwnPropertyDescriptor(ds, 'manager')).toBeDefined();
      expect(Object.getOwnPropertyDescriptor(DataSource.prototype, 'manager')).toBeUndefined();
    });

    it('reports nested-transaction capability via `driver.transactionSupport`', () => {
      // Read by `TypeOrmTransactionAdapter.runInSavepoint` to reject
      // PropagationMode.NESTED on drivers that cannot do savepoints. If
      // the flag disappears the adapter falls back to permissive, so
      // this test is the only thing that would notice.
      const support = (ds.driver as unknown as { transactionSupport?: unknown }).transactionSupport;

      expect(['nested', 'simple', 'none']).toContain(support);
      // sqljs is SQLite-backed, which does support savepoints.
      expect(support).toBe('nested');
    });
  });
});
