import { Injectable } from '@nestjs/common';
import { Transactional } from '@nestjs-transactional/core';
import { getCurrentEntityManager } from '@nestjs-transactional/typeorm';
import { DataSource } from 'typeorm';

import { UserEntity } from './user.entity';

@Injectable()
export class UserService {
  constructor(private readonly dataSource: DataSource) {}

  @Transactional()
  async createUser(id: string, name: string): Promise<void> {
    const em = getCurrentEntityManager('default', this.dataSource);
    await em.save(UserEntity, { id, name });
  }

  @Transactional()
  async createUserAndFail(id: string, name: string): Promise<void> {
    const em = getCurrentEntityManager('default', this.dataSource);
    await em.save(UserEntity, { id, name });
    throw new Error('simulated failure after write — should roll back');
  }

  async listAll(): Promise<UserEntity[]> {
    return this.dataSource.manager.find(UserEntity);
  }
}
