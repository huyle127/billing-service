import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request } from 'express';
import { Clock } from '../../../common/clock/clock';
import { AppConfigService } from '../../../common/config/app-config.service';
import { ValidationError } from '../../../common/errors/domain.exception';
import { Public } from '../../../common/identity/public.decorator';
import { StripeWebhookEvent } from '../../stripe/types/stripe.types';
import { constructEventFromSecrets } from '../../stripe/webhook-signature';
import { WebhookService } from '../services/webhook.service';
import { OUTCOME_STATUSES, STRIPE_SIGNATURE_HEADER } from '../webhook.constants';

@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly webhook: WebhookService,
    private readonly config: AppConfigService,
    private readonly clock: Clock,
  ) {}

  @Public()
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async stripe(
    @Req() request: RawBodyRequest<Request>,
    @Headers(STRIPE_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<void> {
    const event = this.verifiedEvent(request.rawBody, signature);
    const outcome = await this.webhook.ingest(event);

    if (outcome.status !== OUTCOME_STATUSES.completed) {
      throw new ServiceUnavailableException(outcome.detail);
    }
  }

  private verifiedEvent(
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): StripeWebhookEvent {
    if (!rawBody || !signature) {
      throw new ValidationError('Stripe webhook request carries no signed body');
    }

    try {
      return constructEventFromSecrets(
        rawBody,
        signature,
        this.config.stripeWebhookSecrets,
        this.clock.now(),
      );
    } catch {
      throw new ValidationError('Stripe webhook signature matches no configured signing secret');
    }
  }
}
