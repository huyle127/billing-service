import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { PrismaService } from '@/common/prisma/prisma.service';
import { UserModule } from '../user.module';
import { UserService } from './user.service';

describe('the user service', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let users: UserService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [PrismaModule, UserModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UserService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('joins the transaction it is given rather than opening its own', async () => {
    const email = `${crypto.randomUUID()}@example.test`;

    await expect(
      prisma.$transaction(async (tx) => {
        await users.createInTransaction(tx, { email });
        throw new Error('the caller abandons the flow');
      }),
    ).rejects.toThrow('the caller abandons the flow');

    expect(await users.findByEmail(email)).toBeNull();
  });

  it('commits when the caller commits', async () => {
    const email = `${crypto.randomUUID()}@example.test`;

    await prisma.$transaction(async (tx) => {
      await users.createInTransaction(tx, { email });
    });

    const stored = await users.findByEmail(email);
    expect(stored?.email).toBe(email);
    expect(stored?.role).toBe('USER');
  });

  it('returns nothing for an address nobody registered', async () => {
    expect(await users.findByEmail('nobody@example.test')).toBeNull();
    expect(await users.findById(crypto.randomUUID())).toBeNull();
  });
});
