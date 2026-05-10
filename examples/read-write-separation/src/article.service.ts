import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { ArticleRow } from './article.entity';

/**
 * Write side. `@InjectRepository(ArticleRow)` (no second argument)
 * resolves against the **default** DataSource — which is the master.
 * `@Transactional()` opens a transaction on the master adapter; the
 * replica DataSource is never touched by these methods.
 *
 * Notice the absence of `dataSource: 'master'` on `@Transactional` —
 * because master IS the default DS, the framework picks it up
 * automatically. Naming the master DS `'default'` (rather than
 * `'master'`) is the conventional choice when you have exactly one
 * write target; it keeps `@Transactional()` calls in your domain
 * layer free of dataSource-specific clutter.
 */
@Injectable()
export class ArticleService {
  constructor(
    @InjectRepository(ArticleRow)
    private readonly articles: Repository<ArticleRow>,
  ) {}

  @Transactional()
  async create(id: string, title: string, body: string): Promise<void> {
    await this.articles.insert({ id, title, body, viewCount: 0 });
  }

  @Transactional()
  async update(id: string, body: string): Promise<void> {
    const result = await this.articles.update(id, { body });
    if (result.affected === 0) {
      throw new Error(`article ${id} not found`);
    }
  }

  /**
   * Demonstrates a write that fails mid-transaction. Callers see the
   * exception; the partial state never reaches master, and therefore
   * never reaches replica either. The integration test
   * `write rollback ...` pins this behaviour.
   */
  @Transactional()
  async createAndFail(id: string, title: string, body: string): Promise<void> {
    await this.articles.insert({ id, title, body, viewCount: 0 });
    throw new Error('simulated write failure');
  }
}
