import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/errors/domain.exception';

export class IdempotencyKeyReusedError extends DomainException {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('IDEMPOTENCY_KEY_REUSED', message, HttpStatus.BAD_REQUEST, details);
  }
}

export class AdjustmentExceedsBalanceError extends DomainException {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('ADJUSTMENT_EXCEEDS_BALANCE', message, HttpStatus.BAD_REQUEST, details);
  }
}
