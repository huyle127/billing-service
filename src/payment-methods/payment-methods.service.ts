import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BillingException } from '../common/errors/billing.exception';
import { ErrorCode } from '../common/errors/error-code';
import { CustomersService } from '../customers/customers.service';
import { Prisma } from '../generated/prisma/client';
import type { PaymentMethodModel } from '../generated/prisma/models';
import { PrismaService } from '../prisma/prisma.service';
import { BILLING_PROVIDER } from '../provider/billing-provider';
import type {
  BillingProvider,
  ProviderPaymentMethod,
} from '../provider/billing-provider';

/**
 * The payment-method mirror.
 *
 * Every method here obeys one rule, and the comments exist to keep it visible:
 * **the provider decides, the mirror follows** (design D3). Nothing writes a row
 * before a provider call has confirmed the state it describes, nothing invents a
 * descriptor, and nothing consults this table to decide what gets charged — the
 * provider charges the method its own invoice settings point at.
 *
 * The consequence worth stating: a mirror row is disposable. Losing one costs
 * nothing that a refresh from the provider cannot rebuild, which is why the
 * refresh below is free to delete rows the provider no longer reports.
 */
@Injectable()
export class PaymentMethodsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
  ) {}

  /** The mirror, newest first. A local read: no provider call. */
  list(userId: string): Promise<PaymentMethodModel[]> {
    return this.prisma.paymentMethod.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /**
   * Attaches a method the caller has already collected at the provider.
   *
   * The service is given an identifier, never card data. The mirror row is
   * written from the provider's confirmed response — if the attach call throws,
   * no row exists, which is what "no record ahead of provider confirmation"
   * means in practice.
   */
  async attach(
    userId: string,
    providerPaymentMethodId: string,
  ): Promise<PaymentMethodModel> {
    const customerId = await this.customers.requireProviderCustomer(userId);

    await this.provider.attachPaymentMethod(
      customerId,
      providerPaymentMethodId,
    );

    // Refreshed from the provider's list rather than written from the attach
    // response alone: attaching a customer's first method makes it their
    // default, and the list is where that is visible.
    const mirrored = await this.refreshFromProvider(userId, customerId);

    const attached = mirrored.find(
      (method) => method.providerPaymentMethodId === providerPaymentMethodId,
    );
    if (!attached) {
      throw new BillingException(
        ErrorCode.InvalidPaymentMethod,
        'The provider did not report the payment method as attached.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return attached;
  }

  /**
   * Detaches at the provider, then drops the mirror row. In that order: a row
   * removed before the provider agreed would be a mirror that leads.
   */
  async detach(userId: string, paymentMethodRef: string): Promise<void> {
    const method = await this.requireOwned(userId, paymentMethodRef);

    await this.provider.detachPaymentMethod(method.providerPaymentMethodId);

    await this.prisma.paymentMethod.deleteMany({
      where: { id: method.id },
    });
  }

  /**
   * Makes a method the provider's default for this customer.
   *
   * The local flag is written only from what the provider reports afterwards, so
   * "which card gets charged" has exactly one authority. The previous default is
   * cleared as part of the same refresh — and the database would refuse the
   * write if it were not.
   */
  async setDefault(
    userId: string,
    paymentMethodRef: string,
  ): Promise<PaymentMethodModel> {
    const method = await this.requireOwned(userId, paymentMethodRef);
    const customerId = await this.customers.requireProviderCustomer(userId);

    await this.provider.setDefaultPaymentMethod(
      customerId,
      method.providerPaymentMethodId,
    );

    const mirrored = await this.refreshFromProvider(userId, customerId);
    const refreshed = mirrored.find((row) => row.id === method.id);
    if (!refreshed) {
      // The provider no longer reports it, so the refresh that just deleted the
      // row was right and there is nothing to return.
      throw new BillingException(
        ErrorCode.InvalidPaymentMethod,
        'The provider no longer holds that payment method.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return refreshed;
  }

  /**
   * Rebuilds a user's mirror from what the provider currently holds.
   *
   * One transaction, and the order inside it matters: every default is cleared
   * before any is set, because the partial unique index would otherwise see two
   * rows claiming it mid-update. That the index can refuse this is the point —
   * "one default per user" is a database invariant, not a convention this method
   * happens to honour.
   *
   * Rows the provider does not report are deleted. The mirror follows provider
   * state, including in the negative: a method detached elsewhere is gone.
   */
  async refreshFromProvider(
    userId: string,
    knownCustomerId?: string,
  ): Promise<PaymentMethodModel[]> {
    const customerId = knownCustomerId ?? (await this.customerIdFor(userId));
    if (!customerId) {
      return [];
    }

    const atProvider = await this.provider.listPaymentMethods(customerId);

    return this.prisma.$transaction(async (tx) => {
      await tx.paymentMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });

      for (const method of atProvider) {
        await this.upsertMirror(tx, userId, method);
      }

      await tx.paymentMethod.deleteMany({
        where: {
          userId,
          providerPaymentMethodId: {
            notIn: atProvider.map((method) => method.id),
          },
        },
      });

      return tx.paymentMethod.findMany({
        where: { userId },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
    });
  }

  /**
   * Applies one provider-reported method to the mirror, whoever it belongs to.
   *
   * Keyed on the provider's identifier, so an attach response and the webhook
   * reporting the same attachment converge on one row whichever arrives first
   * (design risk "webhook arrives before attach response").
   */
  upsertMirror(
    client: Prisma.TransactionClient,
    userId: string,
    method: ProviderPaymentMethod,
  ): Promise<PaymentMethodModel> {
    const descriptors = {
      brand: method.brand,
      last4: method.last4,
      expMonth: method.expMonth,
      expYear: method.expYear,
      isDefault: method.isDefault,
    };

    return client.paymentMethod.upsert({
      where: { providerPaymentMethodId: method.id },
      create: {
        userId,
        providerPaymentMethodId: method.id,
        ...descriptors,
      },
      update: descriptors,
    });
  }

  /**
   * Updates an existing row's descriptors from a provider report, for the case
   * where the report names no customer and a full refresh is therefore not
   * possible. Touches no `isDefault`: which method is default is a fact about
   * the customer, and a single method's payload cannot establish it.
   *
   * Returns whether a row was there to update — an unknown method is not this
   * service's to create without knowing whose it is.
   */
  async patchDescriptors(method: ProviderPaymentMethod): Promise<boolean> {
    const patched = await this.prisma.paymentMethod.updateMany({
      where: { providerPaymentMethodId: method.id },
      data: {
        brand: method.brand,
        last4: method.last4,
        expMonth: method.expMonth,
        expYear: method.expYear,
      },
    });
    return patched.count > 0;
  }

  /** Removes a mirror row for a method the provider no longer holds. */
  async forget(providerPaymentMethodId: string): Promise<number> {
    const removed = await this.prisma.paymentMethod.deleteMany({
      where: { providerPaymentMethodId },
    });
    return removed.count;
  }

  /** The user a provider customer belongs to, or null if we hold no such user. */
  findUserByCustomerId(customerId: string): Promise<{ id: string } | null> {
    return this.prisma.user.findUnique({
      where: { stripeCustomerId: customerId },
      select: { id: true },
    });
  }

  /**
   * Resolves a reference from the URL against this user's methods, accepting
   * either the mirror row's id or the provider's identifier — a client that has
   * just collected a method knows only the latter.
   *
   * A reference that matches nothing of theirs is INVALID_PAYMENT_METHOD rather
   * than NOT_FOUND: from the caller's side the two are the same mistake, and
   * answering differently would say whether the method exists for someone else.
   */
  private async requireOwned(
    userId: string,
    reference: string,
  ): Promise<PaymentMethodModel> {
    const method = await this.prisma.paymentMethod.findFirst({
      where: {
        userId,
        OR: [
          { providerPaymentMethodId: reference },
          ...(isUuid(reference) ? [{ id: reference }] : []),
        ],
      },
    });

    if (!method) {
      throw new BillingException(
        ErrorCode.InvalidPaymentMethod,
        'No payment method of yours matches that reference.',
        HttpStatus.BAD_REQUEST,
        { paymentMethod: reference },
      );
    }
    return method;
  }

  private async customerIdFor(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });
    return user?.stripeCustomerId ?? null;
  }
}

/**
 * Mirror ids are uuids and provider ids are not, so a non-uuid reference must
 * not reach the `id` column — Postgres rejects the comparison outright rather
 * than simply not matching.
 */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
