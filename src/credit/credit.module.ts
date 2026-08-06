import { Module } from '@nestjs/common';
import { MetricsModule } from '../common/metrics/metrics.module';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CreditController } from './controllers/credit.controller';
import { CreditTransactionRepository } from './repositories/credit-transaction.repository';
import { CreditWalletRepository } from './repositories/credit-wallet.repository';
import { CreditService } from './services/credit.service';

@Module({
  imports: [PrismaModule, MetricsModule],
  controllers: [CreditController],
  providers: [CreditService, CreditWalletRepository, CreditTransactionRepository],
  exports: [CreditService],
})
export class CreditModule {}
