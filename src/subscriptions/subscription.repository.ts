import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type {
  PlanModel,
  PricingOptionModel,
  SubscriptionModel,
} from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';
import { LIVE_SUBSCRIPTION_STATUSES } from './subscription-status';

export type TransactionClient = Prisma.TransactionClient;

/** A Subscription with the catalog rows its callers need. */
export type SubscriptionWithCatalog = SubscriptionModel & {
  plan: PlanModel;
  pricingOption: PricingOptionModel;
};

const WITH_CATALOG = { plan: true, pricingOption: true } as const;

export interface InsertSubscriptionInput {
  userId: string;
  productId: string;
  planId: string;
  pricingOptionId: string;
  providerSubscriptionId: string;
  status: SubscriptionModel['status'];
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  nextCreditResetAt: Date | null;
}

/** The fields a provider report projects onto a local row. */
export interface ProviderProjection {
  status?: SubscriptionModel['status'];
  cancelAtPeriodEnd?: boolean;
  currentPeriodStart?: Date | null;
  currentPeriodEnd?: Date | null;
  pricingOptionId?: string;
  nextCreditResetAt?: Date | null;
}

/**
 * All subscription data access, and the only file that writes a Subscription
 * row.
 *
 * Every method that participates in a transaction takes the transaction client
 * as a parameter; this repository never opens one. That matters most for the
 * Free ↔ Pro transitions, where the row leaving the live set, the row entering
 * it, and the credit movement must commit together or not at all — the
 * one-live-row index is what arbitrates, and it can only do so inside a
 * transaction the *service* owns.
 *
 * Note on scope: catalog reads stay out of here. `subscription-lifecycle`
 * resolves a pricing option by provider price id, which is a read of the
 * catalog rather than of subscriptions, and the same query already exists in
 * `webhooks/handlers/invoice-paid.handler.ts`. Consolidating those two belongs
 * in a catalog-scoped change.
 */
@Injectable()
export class SubscriptionRepository {
  constructor(private readonly prisma: PrismaService) {}

  private client(tx?: TransactionClient): TransactionClient | PrismaService {
    return tx ?? this.prisma;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * The live Subscription for a user and Product, with its catalog rows.
   *
   * One definition of "live", because add-on eligibility, the billing-state
   * read, and credit spendability all ask it and must not be able to disagree.
   */
  findLive(
    userId: string,
    productId: string,
    tx?: TransactionClient,
  ): Promise<SubscriptionWithCatalog | null> {
    return this.client(tx).subscription.findFirst({
      where: {
        userId,
        productId,
        status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
      },
      include: WITH_CATALOG,
    });
  }

  /**
   * A subscription by id, scoped to its owner.
   *
   * The `userId` in the filter is what stops a caller acting on someone else's
   * subscription: a row belonging to another user is not found, which is
   * deliberately the same answer as one that does not exist.
   */
  findOwned(
    userId: string,
    subscriptionId: string,
    tx?: TransactionClient,
  ): Promise<SubscriptionWithCatalog | null> {
    return this.client(tx).subscription.findFirst({
      where: { id: subscriptionId, userId },
      include: WITH_CATALOG,
    });
  }

  findById(
    subscriptionId: string,
    tx?: TransactionClient,
  ): Promise<SubscriptionWithCatalog | null> {
    return this.client(tx).subscription.findUnique({
      where: { id: subscriptionId },
      include: WITH_CATALOG,
    });
  }

  findByProviderId(
    providerSubscriptionId: string,
    tx?: TransactionClient,
  ): Promise<SubscriptionModel | null> {
    return this.client(tx).subscription.findUnique({
      where: { providerSubscriptionId },
    });
  }

  /**
   * Every subscription for a user and Product, oldest first.
   *
   * The row sequence *is* the history — transitions create new rows rather than
   * mutating existing ones — so terminal rows are returned alongside the live
   * one.
   */
  listForProduct(
    userId: string,
    productId: string,
    tx?: TransactionClient,
  ): Promise<SubscriptionWithCatalog[]> {
    return this.client(tx).subscription.findMany({
      where: { userId, productId },
      include: WITH_CATALOG,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /**
   * The only place a Subscription row is written, Free and paid alike.
   *
   * Takes a client rather than using its own so an insert can join a
   * transition's transaction, letting the one-live-row index arbitrate between
   * the row leaving the live set and this one entering it.
   */
  insert(
    tx: TransactionClient,
    input: InsertSubscriptionInput,
  ): Promise<SubscriptionModel> {
    return tx.subscription.create({ data: input });
  }

  /** Projects a provider report onto a local row. Never the other way round. */
  update(
    subscriptionId: string,
    data: ProviderProjection,
    tx?: TransactionClient,
  ): Promise<SubscriptionModel> {
    return this.client(tx).subscription.update({
      where: { id: subscriptionId },
      data,
    });
  }

  /**
   * Forces a row out of the live set.
   *
   * The one status written ahead of the provider: the one-live-row index needs
   * the departing row gone in the same transaction the arriving one is created,
   * and the cancellation that makes it true at the provider follows the commit.
   */
  async markCanceled(
    tx: TransactionClient,
    subscriptionId: string,
  ): Promise<void> {
    await tx.subscription.update({
      where: { id: subscriptionId },
      data: { cancelAtPeriodEnd: false, status: 'CANCELED' },
    });
  }

  // ---------------------------------------------------------------------------
  // Checkout attribution
  // ---------------------------------------------------------------------------

  /**
   * Records enough to attribute a later provider event to the user, Product,
   * and SKU that started the checkout. Confers no entitlement.
   */
  async recordCheckout(
    input: {
      userId: string;
      productId: string;
      pricingOptionId: string;
      providerCheckoutSessionId: string;
    },
    tx?: TransactionClient,
  ): Promise<void> {
    await this.client(tx).subscriptionCheckout.create({ data: input });
  }
}
