import { Injectable } from '@nestjs/common';
import { Prisma, WebhookEvent, WebhookStatus } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { StripeWebhookEvent } from '../../stripe/types/stripe.types';

function isDuplicateStripeEventId(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class WebhookEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByStripeEventId(stripeEventId: string): Promise<WebhookEvent | null> {
    return this.prisma.webhookEvent.findUnique({ where: { stripeEventId } });
  }

  async record(event: StripeWebhookEvent, receivedAt: Date): Promise<WebhookEvent> {
    try {
      return await this.prisma.webhookEvent.create({
        data: {
          stripeEventId: event.id,
          type: event.type,
          payload: event.payload as Prisma.InputJsonObject,
          status: WebhookStatus.RECEIVED,
          receivedAt,
        },
      });
    } catch (error) {
      if (!isDuplicateStripeEventId(error)) throw error;

      return this.prisma.webhookEvent.findUniqueOrThrow({ where: { stripeEventId: event.id } });
    }
  }

  async markCompleted(id: string, processedAt: Date): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: WebhookStatus.COMPLETED, failureReason: null, processedAt },
    });
  }

  async markFailed(id: string, failureReason: string, processedAt: Date): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: WebhookStatus.FAILED, failureReason, processedAt },
    });
  }
}
