import { Injectable } from '@nestjs/common';
import {
  BillingCycle,
  Prisma,
  Subscription,
  SubscriptionEventType,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CREDITABLE_STATUSES, PENDING_SYNC_STATUSES } from '../billing.constants';

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

export interface StatusWrite {
  status: SubscriptionStatus;
  stripeStatus?: string;
  canceledAt?: Date;
  endedAt?: Date;
}

export interface StripeFieldWrite {
  stripeSubscriptionId: string;
  stripePriceId: string | null;
  stripeStatus: string;
  stripePeriodEnd?: Date;
  planId?: string;
}

export interface BoundaryWrite {
  paidThroughAt: Date | null;
  nextCreditAt?: Date;
}

export interface NewSubscriptionEvent {
  subscriptionId: string;
  type: SubscriptionEventType;
  reason: string;
  stripeEventId?: string;
  occurredAt: Date;
}

export type SubscriptionWithPlan = Prisma.SubscriptionGetPayload<{ include: { plan: true } }>;

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

  findById(tx: Prisma.TransactionClient, id: string): Promise<Subscription | null> {
    return tx.subscription.findUnique({ where: { id } });
  }

  async writeStatus(
    tx: Prisma.TransactionClient,
    id: string,
    write: StatusWrite,
  ): Promise<void> {
    await tx.subscription.update({ where: { id }, data: write });
  }

  async writeStripeFields(
    tx: Prisma.TransactionClient,
    id: string,
    write: StripeFieldWrite,
  ): Promise<void> {
    await tx.subscription.update({
      where: { id },
      data: { ...write, syncAttempts: 0, syncError: null },
    });
  }

  async writeBoundaries(
    tx: Prisma.TransactionClient,
    id: string,
    write: BoundaryWrite,
  ): Promise<void> {
    await tx.subscription.update({ where: { id }, data: write });
  }

  async appendEvent(tx: Prisma.TransactionClient, event: NewSubscriptionEvent): Promise<void> {
    await tx.subscriptionEvent.create({ data: event });
  }

  findPendingByUserId(userId: string): Promise<SubscriptionWithPlan | null> {
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

  async advanceNextCreditAt(
    tx: Prisma.TransactionClient,
    id: string,
    nextCreditAt: Date,
  ): Promise<void> {
    await tx.subscription.update({ where: { id }, data: { nextCreditAt } });
  }

  findDueForCredit(now: Date, batchSize: number): Promise<SubscriptionWithPlan[]> {
    return this.prisma.subscription.findMany({
      where: {
        cycle: BillingCycle.ANNUAL,
        status: { in: [...CREDITABLE_STATUSES] },
        nextCreditAt: { lte: now, lt: this.prisma.subscription.fields.paidThroughAt },
      },
      include: { plan: true },
      orderBy: { nextCreditAt: 'asc' },
      take: batchSize,
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
