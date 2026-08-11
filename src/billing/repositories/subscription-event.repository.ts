import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionEvent } from '@prisma/client';
import { CursorBound, CursorWindow } from '../../common/pagination/cursor-window';
import { PrismaService } from '../../common/prisma/prisma.service';

function boundOf(bound: CursorBound): Prisma.SubscriptionEventWhereInput {
  if (bound.ties === 'all') return { occurredAt: { lte: bound.at } };

  if (bound.ties === 'none') return { occurredAt: { lt: bound.at } };

  return {
    OR: [{ occurredAt: { lt: bound.at } }, { occurredAt: bound.at, id: { lt: bound.id } }],
  };
}

function windowOf(window: CursorWindow): Prisma.SubscriptionEventWhereInput[] {
  return [
    ...(window.from ? [{ occurredAt: { gte: window.from } }] : []),
    ...(window.before ? [boundOf(window.before)] : []),
  ];
}

@Injectable()
export class SubscriptionEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  listForHistory(userId: string, window: CursorWindow): Promise<SubscriptionEvent[]> {
    return this.prisma.subscriptionEvent.findMany({
      where: { subscription: { userId }, AND: windowOf(window) },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: window.limit,
    });
  }
}
