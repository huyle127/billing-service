import { Injectable } from '@nestjs/common';
import { AddonPackage, Prisma } from '@prisma/client';

@Injectable()
export class AddonPackageRepository {
  findById(tx: Prisma.TransactionClient, id: string): Promise<AddonPackage | null> {
    return tx.addonPackage.findUnique({ where: { id } });
  }

  findActiveByCode(tx: Prisma.TransactionClient, code: string): Promise<AddonPackage | null> {
    return tx.addonPackage.findFirst({ where: { code, active: true } });
  }

  listActive(tx: Prisma.TransactionClient): Promise<AddonPackage[]> {
    return tx.addonPackage.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
  }

  listAll(tx: Prisma.TransactionClient): Promise<AddonPackage[]> {
    return tx.addonPackage.findMany({ orderBy: { code: 'asc' } });
  }

  listCodes(tx: Prisma.TransactionClient): Promise<{ code: string }[]> {
    return tx.addonPackage.findMany({ select: { code: true } });
  }

  create(
    tx: Prisma.TransactionClient,
    data: Prisma.AddonPackageUncheckedCreateInput,
  ): Promise<AddonPackage> {
    return tx.addonPackage.create({ data });
  }

  update(
    tx: Prisma.TransactionClient,
    id: string,
    data: Prisma.AddonPackageUncheckedUpdateInput,
  ): Promise<AddonPackage> {
    return tx.addonPackage.update({ where: { id }, data });
  }
}
