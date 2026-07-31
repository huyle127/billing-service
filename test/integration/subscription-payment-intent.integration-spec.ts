import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AddonsService } from '../../src/addons/addons.service';
import { CatalogModule } from '../../src/catalog/catalog.module';
import {
  CATALOG_PRICE_REFS,
  seedCatalog,
} from '../../src/catalog/catalog-seed';
import { CreditRepository } from '../../src/credits/credit.repository';
import { CreditsService } from '../../src/credits/credits.service';
import { CustomersService } from '../../src/customers/customers.service';
import {
  BillingInterval,
  CreditGrantSource,
} from '../../src/generated/prisma/enums';
import { PaymentMethodsService } from '../../src/payment-methods/payment-methods.service';
import { PaymentsService } from '../../src/payments/payments.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { BILLING_PROVIDER } from '../../src/provider/billing-provider';
import type { ProviderInvoice } from '../../src/provider/billing-provider';
import { FakeBillingProvider } from '../../src/provider/testing/fake-billing.provider';
import type { FakeDelivery } from '../../src/provider/testing/fake-billing.provider';
import { ProvisioningService } from '../../src/subscriptions/provisioning.service';
import { SubscriptionLifecycleService } from '../../src/subscriptions/subscription-lifecycle.service';
import { SubscriptionLookupService } from '../../src/subscriptions/subscription-lookup.service';
import { SubscriptionRepository } from '../../src/subscriptions/subscription.repository';
import { CheckoutCompletedHandler } from '../../src/webhooks/handlers/checkout-completed.handler';
import { InvoicePaidHandler } from '../../src/webhooks/handlers/invoice-paid.handler';
import { InvoicePaymentFailedHandler } from '../../src/webhooks/handlers/invoice-payment-failed.handler';
import { PaymentMethodHandler } from '../../src/webhooks/handlers/payment-method.handler';
import { SubscriptionEndedHandler } from '../../src/webhooks/handlers/subscription-ended.handler';
import { SubscriptionUpdatedHandler } from '../../src/webhooks/handlers/subscription-updated.handler';
import { WebhookService } from '../../src/webhooks/webhook.service';
import { testDatabase } from './test-database';

/**
 * The provider payment identifier on a subscription payment, asserted against
 * `specs/billing-history/spec.md` → *Payment History Is Complete*.
 *
 * Stripe does not put the payment intent on a delivered invoice — `payments` is
 * an expandable field and a delivery cannot expand it — so the service resolves
 * it through the seam. These tests exist because the previous shape of this
 * code left the column null on every subscription payment, invisibly, behind a
 * fake provider that supplied a value Stripe never sends.
 */

const PRICE_IDS = Object.fromEntries(
  CATALOG_PRICE_REFS.map((ref) => [ref, `price_test_${ref.toLowerCase()}`]),
);

const CHECKOUT_URLS = {
  successUrl: 'https://test.local/success',
  cancelUrl: 'https://test.local/cancel',
};

describe('the payment identifier on a subscription payment', () => {
  let moduleRef: TestingModule;
  let webhooks: WebhookService;
  let provisioning: ProvisioningService;
  let lifecycle: SubscriptionLifecycleService;
  let provider: FakeBillingProvider;
  let productId: string;
  let userId: string;

  beforeAll(async () => {
    provider = new FakeBillingProvider();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        CatalogModule,
      ],
      providers: [
        WebhookService,
        InvoicePaidHandler,
        InvoicePaymentFailedHandler,
        CheckoutCompletedHandler,
        AddonsService,
        SubscriptionUpdatedHandler,
        SubscriptionEndedHandler,
        CreditRepository,
        CreditsService,
        CustomersService,
        PaymentsService,
        PaymentMethodsService,
        PaymentMethodHandler,
        ProvisioningService,
        SubscriptionLifecycleService,
        SubscriptionLookupService,
        SubscriptionRepository,
        { provide: BILLING_PROVIDER, useValue: provider },
      ],
    }).compile();
    await moduleRef.init();

    webhooks = moduleRef.get(WebhookService);
    provisioning = moduleRef.get(ProvisioningService);
    lifecycle = moduleRef.get(SubscriptionLifecycleService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    provider.reset();
    const seeded = await seedCatalog(testDatabase.prisma, PRICE_IDS);
    productId = seeded.productId;
    const user = await testDatabase.prisma.user.create({
      data: { email: `${randomUUID()}@test.local` },
    });
    userId = user.id;
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function payForPro(): Promise<string> {
    const checkout = await lifecycle.createProCheckout({
      userId,
      productId,
      billingInterval: BillingInterval.MONTH,
      ...CHECKOUT_URLS,
    });
    return provider.completeCheckout(checkout.checkoutSessionId).id;
  }

  function deliverInvoicePaid(
    providerSubscriptionId: string,
    overrides: Partial<ProviderInvoice> = {},
  ): FakeDelivery {
    return provider.deliver('invoice.paid', {
      kind: 'invoice-paid',
      invoice: provider.invoiceFor(providerSubscriptionId, {
        amountPaid: 2000,
        amountDue: 2000,
        ...overrides,
      }),
    });
  }

  /** The delivery plus the invoice it carries, when a test needs the id. */
  function invoicePaidWith(
    providerSubscriptionId: string,
    overrides: Partial<ProviderInvoice> = {},
  ): { invoice: ProviderInvoice; delivery: FakeDelivery } {
    const invoice = provider.invoiceFor(providerSubscriptionId, {
      amountPaid: 2000,
      amountDue: 2000,
      ...overrides,
    });
    return {
      invoice,
      delivery: provider.deliver('invoice.paid', {
        kind: 'invoice-paid',
        invoice,
      }),
    };
  }

  function receive(delivery: FakeDelivery) {
    return webhooks.receive(delivery.payload, delivery.signature);
  }

  function grants() {
    return testDatabase.prisma.creditGrant.findMany({
      where: { userId, productId },
    });
  }

  /** Free, then Pro paid for and its first invoice delivered. */
  async function upgradedToPro(): Promise<string> {
    await provisioning.provisionFreeSubscription(userId, productId);
    const providerSubscriptionId = await payForPro();
    await receive(deliverInvoicePaid(providerSubscriptionId));
    return providerSubscriptionId;
  }

  function paymentsFor(userForPayments = userId) {
    return testDatabase.prisma.payment.findMany({
      where: { userId: userForPayments },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ==========================================================================
  describe('Requirement: Payment History Is Complete', () => {
    it('Successful recurring payment carries the provider payment identifier', async () => {
      const providerSubscriptionId = await upgradedToPro();

      // A renewal, which is the `renew()` path.
      await receive(deliverInvoicePaid(providerSubscriptionId));

      const payments = await paymentsFor();
      expect(payments).toHaveLength(2);
      for (const payment of payments) {
        expect(payment.providerPaymentIntentId).toEqual(
          expect.stringMatching(/^pi_/),
        );
      }
    });

    it('carries it on the first paid invoice of a subscription', async () => {
      // The `startPaidSubscription` path, which is separate code from the
      // renewal above and made no provider call at all before this change.
      await provisioning.provisionFreeSubscription(userId, productId);
      const providerSubscriptionId = await payForPro();

      await receive(deliverInvoicePaid(providerSubscriptionId));

      const payments = await paymentsFor();
      expect(payments).toHaveLength(1);
      expect(payments[0].providerPaymentIntentId).toEqual(
        expect.stringMatching(/^pi_/),
      );
    });

    it('A payment the provider cannot identify is visible', async () => {
      const providerSubscriptionId = await upgradedToPro();

      // The provider has no payment intent for this invoice at all — not
      // merely absent from the delivery, absent from the retrieval too.
      const { delivery } = invoicePaidWith(providerSubscriptionId, {
        paymentIntentId: null,
      });
      await receive(delivery);

      const latest = (await paymentsFor()).at(-1)!;
      // Recorded, and recorded without an identifier — never against an
      // invented one.
      expect(latest.providerPaymentIntentId).toBeNull();
      expect(latest.providerInvoiceId).not.toBeNull();
    });

    it('resolves nothing when the delivery already carries an identifier', async () => {
      // A payload that does carry one is used as it stands. The retrieval is a
      // fallback for a known gap, not an unconditional second fetch.
      const providerSubscriptionId = await upgradedToPro();
      const before = provider.callsTo('getInvoice').length;

      const { delivery } = invoicePaidWith(providerSubscriptionId, {
        paymentIntentId: 'pi_carried_on_the_delivery',
      });
      await receive(delivery);

      expect(provider.callsTo('getInvoice')).toHaveLength(before);
      expect((await paymentsFor()).at(-1)!.providerPaymentIntentId).toBe(
        'pi_carried_on_the_delivery',
      );
    });

    it('No duplicate payment records', async () => {
      // The dedup key is unchanged, but the extra provider read is new and
      // must not have disturbed it.
      const providerSubscriptionId = await upgradedToPro();
      const { delivery } = invoicePaidWith(providerSubscriptionId);

      const first = await receive(delivery);
      const second = await receive(provider.redeliver(delivery));

      expect(first.outcome).toBe('processed');
      expect(second.outcome).toBe('duplicate');
      expect(await paymentsFor()).toHaveLength(2);
    });

    it('leaves credit allocation untouched', async () => {
      const providerSubscriptionId = await upgradedToPro();
      const afterUpgrade = await grants();
      expect(afterUpgrade).toHaveLength(1);

      // A genuine renewal covers the *next* period. Delivering one for the same
      // period again would allocate nothing — the per-credit-period unique
      // index arbitrates that — so the period is advanced to make this a real
      // second allocation rather than a silent no-op.
      const nextPeriodStart = afterUpgrade[0].creditPeriodEnd!;
      await receive(
        deliverInvoicePaid(providerSubscriptionId, {
          periodStart: nextPeriodStart,
          periodEnd: new Date(
            nextPeriodStart.getTime() + 30 * 24 * 60 * 60 * 1000,
          ),
        }),
      );

      const afterRenewal = await grants();
      // Exactly one further period, from the plan's policy, still
      // subscription-sourced. The extra provider read changed none of it.
      expect(afterRenewal).toHaveLength(2);
      for (const grant of afterRenewal) {
        expect(grant.source).toBe(CreditGrantSource.SUBSCRIPTION);
        expect(grant.amountInitial).toBe(100);
      }
    });

    it('allocates nothing extra for a repeated period', async () => {
      // The property the test above had to work around, asserted rather than
      // merely avoided: a second paid invoice covering a period already
      // granted adds no grant, and still records its own payment.
      const providerSubscriptionId = await upgradedToPro();

      await receive(deliverInvoicePaid(providerSubscriptionId));

      expect(await grants()).toHaveLength(1);
      expect(await paymentsFor()).toHaveLength(2);
    });

    it('A payment identifier absent from the delivery is still recorded', async () => {
      // The delivered invoice carries none — as Stripe's never does — so the
      // value can only have come from asking the provider for it.
      const providerSubscriptionId = await upgradedToPro();
      const delivery = deliverInvoicePaid(providerSubscriptionId);

      const delivered = provider.events.get(delivery.eventId)!;
      expect(delivered.billing).toMatchObject({
        kind: 'invoice-paid',
        invoice: { paymentIntentId: null },
      });

      await receive(delivery);

      const latest = (await paymentsFor()).at(-1)!;
      expect(latest.providerPaymentIntentId).toEqual(
        expect.stringMatching(/^pi_/),
      );
    });
  });
});
