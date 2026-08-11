import { Controller, Get } from '@nestjs/common';
import { AddonPackage, Plan } from '@prisma/client';
import { Public } from '@/common/identity/public.decorator';
import { CatalogService } from '../services/catalog.service';

@Controller()
@Public()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('plans')
  listPlans(): Promise<Plan[]> {
    return this.catalog.listPlans();
  }

  @Get('addon-packages')
  listPackages(): Promise<AddonPackage[]> {
    return this.catalog.listPackages();
  }
}
