import { PrismaClient, Role } from '@prisma/client';
import { hash } from 'bcrypt';

export async function seedAdmin(prisma: PrismaClient): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD?.trim();

  if (!email || !password) {
    console.log('ADMIN_EMAIL or ADMIN_PASSWORD is not set — no admin seeded');
    return;
  }

  if (await prisma.user.findUnique({ where: { email } })) {
    console.log(`admin ${email} already exists`);
    return;
  }

  const passwordHash = await hash(password, Number(process.env.BCRYPT_SALT_ROUNDS ?? 12));

  await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { email, role: Role.ADMIN } });
    await tx.authCredential.create({ data: { userId: user.id, passwordHash } });
  });

  console.log(`seeded admin ${email}`);
}
