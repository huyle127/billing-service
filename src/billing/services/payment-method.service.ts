import { Injectable } from '@nestjs/common';
import { PaymentMethod, SubscriptionStatus } from '@prisma/client';
import { Clock } from '../../common/clock/clock';
import { NotFoundError } from '../../common/errors/domain.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FREE_PLAN } from '../billing.constants';
import { PaymentMethodRequiredError } from '../billing.errors';
import { PaymentMethodRepository } from '../repositories/payment-method.repository';
import { SubscriptionRepository } from '../repositories/subscription.repository';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { ProvisioningService } from './provisioning.service';

const RENEWING_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

export interface PaymentMethodView {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
}

function view(method: PaymentMethod): PaymentMethodView {
  return {
    id: method.id,
    brand: method.brand,
    last4: method.last4,
    expMonth: method.expMonth,
    expYear: method.expYear,
    isDefault: method.isDefault,
  };
}

@Injectable()
export class PaymentMethodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly methods: PaymentMethodRepository,
    private readonly subscriptions: SubscriptionRepository,
    private readonly provisioning: ProvisioningService,
    private readonly stripe: StripeService,
    private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<PaymentMethodView[]> {
    const attached = await this.methods.listAttached(userId);

    return attached.map(view);
  }

  async attach(userId: string, paymentMethodId: string): Promise<PaymentMethodView> {
    const customerId = await this.provisioning.ensureCustomer(userId);
    const existing = await this.methods.countAttached(userId);
    const setAsDefault = existing === 0;

    const remote = await this.stripe.attachPaymentMethod({
      customerId,
      paymentMethodId,
      setAsDefault,
    });

    const recorded = await this.prisma.$transaction((tx) =>
      this.methods.record(tx, {
        userId,
        stripePaymentMethodId: remote.id,
        brand: remote.brand,
        last4: remote.last4,
        expMonth: remote.expMonth,
        expYear: remote.expYear,
        isDefault: setAsDefault,
      }),
    );

    return view(recorded);
  }

  async detach(userId: string, id: string): Promise<void> {
    const method = await this.methods.findAttached(userId, id);

    if (!method) throw new NotFoundError('This payment method is not attached', { id });

    await this.refuseLastCardWhileRenewing(userId);
    await this.stripe.detachPaymentMethod(method.stripePaymentMethodId);
    await this.prisma.$transaction((tx) =>
      this.methods.markDetached(tx, method.stripePaymentMethodId, this.clock.now()),
    );
  }

  private async refuseLastCardWhileRenewing(userId: string): Promise<void> {
    if ((await this.methods.countAttached(userId)) > 1) return;

    const current = await this.subscriptions.findCurrentWithPlan(userId);

    if (!current) return;
    if (current.plan.code === FREE_PLAN.code) return;
    if (!RENEWING_STATUSES.includes(current.status)) return;

    throw new PaymentMethodRequiredError(
      'A running paid subscription needs a payment method; attach another before detaching this one',
      { subscriptionId: current.id, planCode: current.plan.code },
    );
  }
}
