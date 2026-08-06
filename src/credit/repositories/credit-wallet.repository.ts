import { Injectable } from '@nestjs/common';
import { Prisma, WalletStatus } from '@prisma/client';
import { LedgerBalances } from '../services/draw-split';

export interface LockedWallet {
  id: string;
  status: WalletStatus;
  subscriptionCredits: number;
  addonCredits: number;
}

@Injectable()
export class CreditWalletRepository {
  async lockByUserId(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<LockedWallet | undefined> {
    const [wallet] = await tx.$queryRaw<LockedWallet[]>`
      SELECT "id", "status", "subscriptionCredits", "addonCredits"
      FROM "CreditWallet"
      WHERE "userId" = ${userId}
      FOR UPDATE
    `;

    return wallet;
  }

  async setBalances(
    tx: Prisma.TransactionClient,
    walletId: string,
    balances: LedgerBalances,
  ): Promise<void> {
    await tx.creditWallet.update({
      where: { id: walletId },
      data: { subscriptionCredits: balances.subscription, addonCredits: balances.addon },
    });
  }
}
