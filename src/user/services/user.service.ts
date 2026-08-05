import { Injectable } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  createInTransaction(
    tx: Prisma.TransactionClient,
    input: { email: string; role?: Role },
  ): Promise<User> {
    return tx.user.create({ data: input });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }
}
