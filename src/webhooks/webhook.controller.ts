import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { STRIPE_WEBHOOK_PATH } from '../common/constants';
import { WebhookReceipt, WebhookService } from './webhook.service';

/**
 * The provider's delivery endpoint.
 *
 * Thin by necessity as well as by convention: it is publicly reachable and
 * unauthenticated, so its entire trust model is the signature check that happens
 * one call down. It acknowledges promptly rather than blocking on downstream
 * work, because a delivery that times out is a delivery the provider will send
 * again.
 */
@ApiTags('webhooks')
@Controller(STRIPE_WEBHOOK_PATH.replace(/^\//, ''))
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  /**
   * `200` for everything the signature verifies, including duplicates and event
   * types this service does not act upon — a non-2xx asks the provider to retry
   * an event that will never succeed. An invalid signature is the one case that
   * throws, and the error filter turns it into the standard shape.
   *
   * The body arrives as a `Buffer` because the webhook route is mounted with a
   * raw body parser before the JSON one; a re-serialised body would not verify.
   */
  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive a provider webhook delivery',
    description:
      'Public by design: the delivery is authenticated by its signature, not ' +
      'by a bearer token. The body must be the exact bytes the provider sent.',
  })
  @ApiHeader({ name: 'stripe-signature', required: true })
  receive(
    @Req() request: Request,
    @Headers('stripe-signature') signature?: string,
  ): Promise<WebhookReceipt> {
    return this.webhooks.receive(
      Buffer.isBuffer(request.body) ? request.body : Buffer.from(''),
      signature ?? '',
    );
  }
}
