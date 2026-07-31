import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type { BillingProvider } from '../provider/billing-provider';
import { PrismaService } from '../prisma/prisma.service';

export interface CustomerView {
  userId: string;
  email: string;
  stripeCustomerId: string;
}

/**
 * Owns the one Stripe Customer a user may have.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /**
   * Returns the user's Stripe Customer identifier, creating one if needed.
   *
   * Under concurrency two callers can both find none and both create one at
   * the provider. The unique index on `stripe_customer_id` decides which is
   * stored, and the loser deletes nothing but reports the winner — so exactly
   * one identifier is ultimately stored. The surplus provider customer is
   * harmless (it holds no subscription) and is what reconciliation exists for;
   * a customer, unlike a subscription, costs nothing and charges nobody.
   */
  async getOrCreateStripeCustomer(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new BillingException(
        ErrorCode.NotFound,
        'No such user.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customer = await this.provider.createCustomer({
      email: user.email,
      userId: user.id,
    });

    // Only claim the column if it is still empty, so a concurrent winner is
    // never overwritten.
    const claimed = await this.prisma.user.updateMany({
      where: { id: userId, stripeCustomerId: null },
      data: { stripeCustomerId: customer.id },
    });

    if (claimed.count === 1) {
      return customer.id;
    }

    const current = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return current.stripeCustomerId!;
  }

  /**
   * The user's billing identity: their email and the provider customer that
   * carries their subscriptions.
   *
   * Creating the customer on read is deliberate. A user who has never bought
   * anything has no reason to have one yet, and the alternative — reporting
   * "none" and making the client ask again after some other call created it —
   * would expose provisioning order as an API concern.
   */
  async getCustomerView(userId: string): Promise<CustomerView> {
    const stripeCustomerId = await this.getOrCreateStripeCustomer(userId);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true },
    });

    return { userId: user.id, email: user.email, stripeCustomerId };
  }

  /** Resolves a customer at the provider, as a standardised error if absent. */
  async requireProviderCustomer(userId: string): Promise<string> {
    const customerId = await this.getOrCreateStripeCustomer(userId);
    const customer = await this.provider.getCustomer(customerId);
    if (!customer) {
      throw new BillingException(
        ErrorCode.MissingStripeCustomer,
        'The billing provider has no customer for this user.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return customer.id;
  }
}
