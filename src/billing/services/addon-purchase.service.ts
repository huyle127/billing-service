import { Injectable } from '@nestjs/common';
import { PaymentStatus, WalletStatus } from '@prisma/client';
import { Clock } from '@/common/clock/clock';
import { NotFoundError } from '@/common/errors/domain.exception';
import { PrismaService } from '@/common/prisma/prisma.service';
import { CreditService } from '@/credit/services/credit.service';
import { PURCHASE_DESCRIPTIONS } from '../billing.constants';
import { PaymentMethodRequiredError, WalletFrozenError } from '../billing.errors';
import { AddonPackageRepository } from '../repositories/addon-package.repository';
import { PaymentMethodRepository } from '../repositories/payment-method.repository';
import { PaymentTransactionRepository } from '../repositories/payment-transaction.repository';
import { StripeService } from '../stripe/interfaces/stripe-adapter.interface';
import { ProvisioningService } from './provisioning.service';

export interface PackageChoice {
  packageCode: string;
}

export interface PurchaseView {
  purchaseId: string;
  status: PaymentStatus;
  providerStatus: string;
  packageCode: string;
  credits: number;
  amountCents: number;
  currency: string;
}

@Injectable()
export class AddonPurchaseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly packages: AddonPackageRepository,
    private readonly methods: PaymentMethodRepository,
    private readonly payments: PaymentTransactionRepository,
    private readonly provisioning: ProvisioningService,
    private readonly credit: CreditService,
    private readonly stripe: StripeService,
    private readonly clock: Clock,
  ) {}

  async purchase(userId: string, choice: PackageChoice): Promise<PurchaseView> {
    const pack = await this.packages.findActiveByCode(this.prisma, choice.packageCode);

    if (!pack) {
      throw new NotFoundError('No active add-on package carries that code', {
        packageCode: choice.packageCode,
      });
    }

    const wallet = await this.credit.wallet(userId);

    if (wallet.status === WalletStatus.FROZEN) {
      throw new WalletFrozenError('Settle the outstanding invoice before buying add-on credits');
    }

    const card = await this.methods.findChargeable(userId);

    if (!card) {
      throw new PaymentMethodRequiredError('Attach a payment method before buying add-on credits');
    }

    const customerId = await this.provisioning.ensureCustomer(userId);

    const purchase = await this.payments.openPurchase({
      userId,
      addonPackageId: pack.id,
      amountCents: pack.amountCents,
      currency: pack.currency,
      description: PURCHASE_DESCRIPTIONS.addon(pack.code),
      occurredAt: this.clock.now(),
    });

    const payment = await this.stripe.createOneTimePayment({
      purchaseId: purchase.id,
      userId,
      customerId,
      paymentMethodId: card.stripePaymentMethodId,
      amount: pack.amountCents,
      currency: pack.currency,
      description: purchase.description ?? undefined,
    });

    await this.payments.attachPaymentIntent(purchase.id, payment.id);

    return {
      purchaseId: purchase.id,
      status: purchase.status,
      providerStatus: payment.status,
      packageCode: pack.code,
      credits: pack.credits,
      amountCents: pack.amountCents,
      currency: pack.currency,
    };
  }
}
