import { Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { ProductScopeService } from './product-scope.service';

@Module({
  providers: [CatalogService, ProductScopeService],
  exports: [CatalogService, ProductScopeService],
})
export class CatalogModule {}
