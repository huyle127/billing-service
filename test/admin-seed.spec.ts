import { Role } from '@prisma/client';
import { compare } from 'bcrypt';
import { describe, expect, it } from 'vitest';
import { seedAdmin } from '../prisma/seed-admin';
import { testPrisma } from './setup';

describe('the admin seed', () => {
  it('creates one admin however many times it runs', async () => {
    await seedAdmin(testPrisma);
    await seedAdmin(testPrisma);

    const admins = await testPrisma.user.findMany({ where: { role: Role.ADMIN } });
    expect(admins).toHaveLength(1);
    expect(admins[0].email).toBe(process.env.ADMIN_EMAIL);

    const credential = await testPrisma.authCredential.findUniqueOrThrow({
      where: { userId: admins[0].id },
    });
    expect(await compare(String(process.env.ADMIN_PASSWORD), credential.passwordHash)).toBe(true);
  });

  it('seeds no admin when the configuration is absent', async () => {
    const email = process.env.ADMIN_EMAIL;
    delete process.env.ADMIN_EMAIL;

    try {
      await seedAdmin(testPrisma);
      expect(await testPrisma.user.count()).toBe(0);
    } finally {
      process.env.ADMIN_EMAIL = email;
    }
  });
});
