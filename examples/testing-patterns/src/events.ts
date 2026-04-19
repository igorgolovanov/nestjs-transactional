/** Published whenever a wallet's balance changes through `WalletService`. */
export class WalletOperationEvent {
  constructor(
    readonly walletId: string,
    readonly type: 'deposit' | 'withdraw',
    readonly amount: number,
    readonly balanceAfter: number,
  ) {}
}
