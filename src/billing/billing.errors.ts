import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/errors/domain.exception';

export class PlanInUseError extends DomainException {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PLAN_IN_USE', message, HttpStatus.CONFLICT, details);
  }
}

export class PaymentMethodRequiredError extends DomainException {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('PAYMENT_METHOD_REQUIRED', message, HttpStatus.BAD_REQUEST, details);
  }
}
