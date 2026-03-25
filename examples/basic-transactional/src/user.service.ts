import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Transactional } from '@nestjs-transactional/core';
import { Repository } from 'typeorm';

import { UserEntity } from './user.entity';

/**
 * Phase 14.20 transparent repositories — `@InjectRepository(UserEntity)`
 * resolves a regular TypeORM `Repository`, but its `manager` getter is
 * patched at module load to consult the active `@Transactional()` scope.
 * No `getCurrentEntityManager()` call, no `EntityManager` plumbing in
 * service code.
 */
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  @Transactional()
  async createUser(id: string, name: string): Promise<UserEntity> {
    return this.users.save({ id, name });
  }

  @Transactional()
  async createUserAndFail(id: string, name: string): Promise<void> {
    await this.users.save({ id, name });
    throw new Error('simulated failure after write — should roll back');
  }

  async listAll(): Promise<UserEntity[]> {
    return this.users.find();
  }
}
