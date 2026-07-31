import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUrl } from 'class-validator';
import {
  BillingInterval,
  SubscriptionStatus,
} from '../../generated/prisma/enums';
import type { BillingStateSubscription } from '../billing-state.service';
import type { SubscriptionHistoryEntry } from '../subscription-history.service';

/**
 * Where the provider sends the customer back once a hosted checkout ends. Both
 * checkout flows take the same pair, so both DTOs extend this one rather than
 * declaring it twice.
 */
export class CheckoutUrlsDto {
  @ApiProperty({ example: 'https://app.example.com/billing/success' })
  @IsUrl({ require_tld: false })
  successUrl!: string;

  @ApiProperty({ example: 'https://app.example.com/billing/cancel' })
  @IsUrl({ require_tld: false })
  cancelUrl!: string;
}

export class CreateSubscriptionDto extends CheckoutUrlsDto {
  @ApiProperty({
    enum: BillingInterval,
    description: 'Monthly or annual billing for the paid plan.',
  })
  @IsEnum(BillingInterval)
  billingInterval!: BillingInterval;

  @ApiPropertyOptional({
    description: 'Defaults to the AI product, the only one currently offered.',
  })
  @IsOptional()
  @IsString()
  productKey?: string;
}

export class ChangeCycleDto {
  @ApiProperty({ enum: BillingInterval })
  @IsEnum(BillingInterval)
  billingInterval!: BillingInterval;
}

export class CheckoutSessionDto {
  @ApiProperty({ example: 'cs_1234567890' })
  checkoutSessionId!: string;

  @ApiProperty({
    nullable: true,
    description: 'Where to send the user to complete payment.',
  })
  url!: string | null;
}

/**
 * A subscription as the API reports it. Every field is either the provider's
 * state projected or a classification over it — none is a state this service
 * invented (design D0).
 */
export class SubscriptionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'pro' })
  planKey!: string;

  @ApiProperty({ example: 'Pro' })
  planName!: string;

  @ApiProperty()
  isPaidPlan!: boolean;

  @ApiProperty({ enum: SubscriptionStatus, enumName: 'SubscriptionStatus' })
  status!: SubscriptionStatus;

  @ApiProperty({ enum: BillingInterval })
  billingInterval!: BillingInterval;

  @ApiProperty()
  billingIntervalCount!: number;

  @ApiProperty({
    description:
      'A classification over the provider status, not a stored flag.',
  })
  isLive!: boolean;

  @ApiProperty({
    description:
      'A pending period-end cancellation. The subscription is still live and ' +
      'still entitles its plan until the provider says otherwise.',
  })
  cancelAtPeriodEnd!: boolean;

  @ApiProperty({ nullable: true, format: 'date-time' })
  currentPeriodStart!: Date | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  currentPeriodEnd!: Date | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  nextCreditResetAt!: Date | null;

  @ApiProperty()
  providerSubscriptionId!: string;

  // `this: void` because this is passed to `.map()` as a bare reference. It
  // reads only its argument, so the annotation is accurate and it lets callers
  // detach it from the class.
  static fromHistory(
    this: void,
    entry: SubscriptionHistoryEntry,
  ): SubscriptionDto {
    return {
      id: entry.id,
      planKey: entry.planKey,
      planName: entry.planName,
      isPaidPlan: entry.isPaidPlan,
      status: entry.status,
      billingInterval: entry.billingInterval,
      billingIntervalCount: entry.billingIntervalCount,
      isLive: entry.isLive,
      cancelAtPeriodEnd: entry.cancelAtPeriodEnd,
      currentPeriodStart: entry.currentPeriodStart,
      currentPeriodEnd: entry.currentPeriodEnd,
      nextCreditResetAt: entry.nextCreditResetAt,
      providerSubscriptionId: entry.providerSubscriptionId,
    };
  }

  static fromBillingState(
    subscription: BillingStateSubscription,
  ): SubscriptionDto {
    return {
      id: subscription.id,
      planKey: subscription.planKey,
      planName: subscription.planName,
      isPaidPlan: subscription.isPaidPlan,
      status: subscription.status,
      billingInterval: subscription.billingInterval,
      billingIntervalCount: subscription.billingIntervalCount,
      // It came from the live lookup, so it is live by construction.
      isLive: true,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      nextCreditResetAt: subscription.nextCreditResetAt,
      providerSubscriptionId: subscription.providerSubscriptionId,
    };
  }
}
