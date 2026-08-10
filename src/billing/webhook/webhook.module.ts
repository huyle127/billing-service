import { Module } from '@nestjs/common';
import { ClockModule } from '../../common/clock/clock.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { WebhookController } from './controllers/webhook.controller';
import { SubscriptionTrialWillEndHandler } from './handlers/subscription-trial-will-end.handler';
import { WebhookHandlerRegistry } from './handlers/webhook-handler.registry';
import { WebhookEventRepository } from './repositories/webhook-event.repository';
import { WebhookService } from './services/webhook.service';

@Module({
  imports: [PrismaModule, ClockModule],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookEventRepository,
    WebhookHandlerRegistry,
    SubscriptionTrialWillEndHandler,
  ],
})
export class WebhookModule {}
