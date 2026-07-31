import { Injectable } from '@nestjs/common';
import { CATALOG } from './catalog-seed';
import { CatalogService } from './catalog.service';

/**
 * Which Product an API call is about.
 *
 * The current scope is AI only (AGENTS.md → Scope), so every endpoint would
 * otherwise have to name it. Resolving it here keeps "AI" a row in the catalog
 * rather than a literal repeated across a dozen controllers, and leaves the door
 * open for a caller to name another product once one exists.
 */
@Injectable()
export class ProductScopeService {
  constructor(private readonly catalog: CatalogService) {}

  async resolveProductId(productKey?: string): Promise<string> {
    const product = await this.catalog.getProductByKey(
      productKey ?? CATALOG.product.key,
    );
    return product.id;
  }
}
