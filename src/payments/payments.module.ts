import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/**
 * Payment records, with no controller of its own.
 *
 * Payments are written by webhook handlers and read back as history; neither
 * path is a payment endpoint, so there is no HTTP surface to own. `HistoryModule`
 * exposes the read at `GET /history/payments` and `WebhooksModule` performs the
 * writes. The missing controller is the shape of the domain, not an omission.
 */
@Module({
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
