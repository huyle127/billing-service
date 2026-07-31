import { Module } from '@nestjs/common';
import { CreditHistoryService } from './credit-history.service';
import { CreditRepository } from './credit.repository';
import { CreditsService } from './credits.service';

@Module({
  providers: [CreditsService, CreditHistoryService, CreditRepository],
  exports: [CreditsService, CreditHistoryService],
})
export class CreditsModule {}
