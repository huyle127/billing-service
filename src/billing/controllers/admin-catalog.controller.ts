import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AddonPackage, Plan, Role } from '@prisma/client';
import { Roles } from '@/common/identity/roles.decorator';
import { CreateAddonPackageDto } from '../dto/create-addon-package.dto';
import { CreatePlanDto } from '../dto/create-plan.dto';
import { UpdateAddonPackageDto } from '../dto/update-addon-package.dto';
import { UpdatePlanDto } from '../dto/update-plan.dto';
import { CatalogService } from '../services/catalog.service';

@Controller('admin')
@Roles(Role.ADMIN)
export class AdminCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('plans')
  listPlans(): Promise<Plan[]> {
    return this.catalog.listPlans(true);
  }

  @Post('plans')
  createPlan(@Body() dto: CreatePlanDto): Promise<Plan> {
    return this.catalog.createPlan(dto);
  }

  @Patch('plans/:id')
  revisePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto): Promise<Plan> {
    return this.catalog.revisePlan(id, dto);
  }

  @Delete('plans/:id')
  archivePlan(@Param('id') id: string): Promise<Plan> {
    return this.catalog.archivePlan(id);
  }

  @Get('addon-packages')
  listPackages(): Promise<AddonPackage[]> {
    return this.catalog.listPackages(true);
  }

  @Post('addon-packages')
  createPackage(@Body() dto: CreateAddonPackageDto): Promise<AddonPackage> {
    return this.catalog.createPackage(dto);
  }

  @Patch('addon-packages/:id')
  revisePackage(
    @Param('id') id: string,
    @Body() dto: UpdateAddonPackageDto,
  ): Promise<AddonPackage> {
    return this.catalog.revisePackage(id, dto);
  }

  @Delete('addon-packages/:id')
  archivePackage(@Param('id') id: string): Promise<AddonPackage> {
    return this.catalog.archivePackage(id);
  }
}
