import { Injectable } from '@nestjs/common';
import { BillingCycle, Prisma, Subscription, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PENDING_SYNC_STATUSES } from '../billing.constants';

export interface NewFreeSubscription {
  userId: string;
  planId: string;
  cycle: BillingCycle;
  startedAt: Date;
}

export interface StripeAttachment {
  stripeSubscriptionId: string;
  stripePriceId: string | null;
  stripeStatus: string;
}

export interface ClaimedSubscription {
  id: string;
  userId: string;
  syncAttempts: number;
  syncError: string | null;
  createdAt: Date;
}

export type PendingSubscription = Prisma.SubscriptionGetPayload<{ include: { plan: true } }>;

const PENDING_SYNC_SQL = Prisma.raw(
  PENDING_SYNC_STATUSES.map((status) => `'${status}'`).join(', '),
);

@Injectable()
export class SubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  createFree(
    tx: Prisma.TransactionClient,
    subscription: NewFreeSubscription,
  ): Promise<Subscription> {
    return tx.subscription.create({
      data: { ...subscription, status: SubscriptionStatus.ACTIVE },
    });
  }

  findPendingByUserId(userId: string): Promise<PendingSubscription | null> {
    return this.prisma.subscription.findFirst({
      where: {
        userId,
        stripeSubscriptionId: null,
        status: { in: [...PENDING_SYNC_STATUSES] },
      },
      include: { plan: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async attachStripeSubscription(id: string, attachment: StripeAttachment): Promise<void> {
    await this.prisma.subscription.update({
      where: { id },
      data: { ...attachment, syncAttempts: 0, syncError: null },
    });
  }

  async recordFailure(id: string, syncError: string, syncNextAttemptAt: Date): Promise<void> {
    await this.prisma.subscription.update({
      where: { id },
      data: { syncAttempts: { increment: 1 }, syncError, syncNextAttemptAt },
    });
  }

  claimPending(
    now: Date,
    batchSize: number,
    leaseUntil: (syncAttempts: number) => Date,
  ): Promise<ClaimedSubscription[]> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.$queryRaw<ClaimedSubscription[]>`
        SELECT "id", "userId", "syncAttempts", "syncError", "createdAt"
        FROM "Subscription"
        WHERE "stripeSubscriptionId" IS NULL
          AND "status" IN (${PENDING_SYNC_SQL})
          AND "syncNextAttemptAt" <= ${now.toISOString()}::timestamp
        ORDER BY "syncNextAttemptAt"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      for (const row of claimed) {
        await tx.subscription.update({
          where: { id: row.id },
          data: { syncNextAttemptAt: leaseUntil(row.syncAttempts) },
        });
      }

      return claimed;
    });
  }
}
