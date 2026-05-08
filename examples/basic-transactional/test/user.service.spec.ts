import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import { UserService } from '../src/user.service';

describe('basic-transactional', () => {
  let module: TestingModule;
  let users: UserService;

  beforeEach(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.init();
    users = module.get(UserService);
  });

  afterEach(async () => {
    await module.close();
  });

  it('commits writes when the @Transactional method returns', async () => {
    await users.createUser('alice', 'Alice');

    const ids = (await users.listAll()).map((u) => u.id);
    expect(ids).toContain('alice');
  });

  it('rolls back writes when the @Transactional method throws', async () => {
    await expect(users.createUserAndFail('bob', 'Bob')).rejects.toThrow(
      'simulated failure after write — should roll back',
    );

    const ids = (await users.listAll()).map((u) => u.id);
    expect(ids).not.toContain('bob');
  });

  it('isolates concurrent transactions — successful ones survive a sibling rollback', async () => {
    await users.createUser('carol', 'Carol');
    await expect(users.createUserAndFail('dave', 'Dave')).rejects.toThrow();

    const ids = (await users.listAll()).map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining(['carol']));
    expect(ids).not.toContain('dave');
  });
});
