import 'reflect-metadata';

import { Test, type TestingModule } from '@nestjs/testing';
import { CommandBus } from '@nestjs/cqrs';

import { AppModule } from '../src/app.module';
import { NotificationHandler } from '../src/notification.handler';
import { PlaceOrderCommand } from '../src/place-order.handler';

describe('basic-cqrs', () => {
  let module: TestingModule;
  let commandBus: CommandBus;
  let notifications: NotificationHandler;

  beforeEach(async () => {
    module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await module.init();
    commandBus = module.get(CommandBus);
    notifications = module.get(NotificationHandler);
  });

  afterEach(async () => {
    await module.close();
  });

  it('invokes the AFTER_COMMIT handler after a successful command', async () => {
    await commandBus.execute(new PlaceOrderCommand('o-1'));

    expect(notifications.notified).toEqual(['o-1']);
  });

  it('does NOT invoke the AFTER_COMMIT handler when the command rolls back', async () => {
    await expect(commandBus.execute(new PlaceOrderCommand('o-2', true))).rejects.toThrow(
      'simulated failure — transaction rolls back, AFTER_COMMIT skipped',
    );

    expect(notifications.notified).not.toContain('o-2');
  });

  it('isolates phase delivery per command — successful one fires while sibling rolls back', async () => {
    await commandBus.execute(new PlaceOrderCommand('o-3'));
    await expect(commandBus.execute(new PlaceOrderCommand('o-4', true))).rejects.toThrow();
    await commandBus.execute(new PlaceOrderCommand('o-5'));

    expect(notifications.notified.sort()).toEqual(['o-3', 'o-5']);
  });
});
