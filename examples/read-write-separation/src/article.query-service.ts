import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ArticleRow } from './article.entity';

/**
 * Read side. `@InjectRepository(ArticleRow, 'replica')` resolves
 * against the **replica** DataSource — the second argument is the
 * DS name. There is no `@Transactional` decorator on these methods:
 * each call goes through TypeORM's autocommit path, runs as a
 * single statement under the replica's READ COMMITTED isolation,
 * and never enrols into an ambient master transaction.
 *
 * Why no `@Transactional` here? Three reasons that all happen to
 * agree:
 *
 * 1. Real read replicas are **read-only** at the Postgres level.
 *    `BEGIN; SELECT ...; COMMIT;` works, but `@Transactional` opens
 *    a transaction whose semantics include "could write any time" —
 *    you would then route writes that you forgot to mark explicitly
 *    onto the replica, where they fail with `cannot execute INSERT
 *    in a read-only transaction`. Better to leave the replica out
 *    of the transactional adapter entirely so a misplaced write
 *    fails fast at DI rather than at runtime.
 * 2. Reading inside an explicit transaction adds round trips
 *    (`BEGIN`/`COMMIT`) for no isolation benefit — single-statement
 *    autocommit reads are simpler.
 * 3. The replica DataSource is **not registered with**
 *    `TypeOrmTransactionalModule.forRoot` (see `app.module.ts`), so
 *    `@Transactional({ dataSource: 'replica' })` would resolve at
 *    bootstrap to "no adapter registered for dataSource 'replica'."
 *    The framework refuses to silently fall back.
 */
@Injectable()
export class ArticleQueryService {
  constructor(
    @InjectRepository(ArticleRow, 'replica')
    private readonly articles: Repository<ArticleRow>,
  ) {}

  async list(): Promise<ArticleRow[]> {
    return this.articles.find({ order: { id: 'ASC' } });
  }

  async getById(id: string): Promise<ArticleRow | null> {
    return this.articles.findOneBy({ id });
  }

  async count(): Promise<number> {
    return this.articles.count();
  }
}
