import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-code';

export class DomainException extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: HttpStatus,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends DomainException {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('NOT_FOUND', message, HttpStatus.NOT_FOUND, details);
  }
}

export class ValidationError extends DomainException {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('VALIDATION_FAILED', message, HttpStatus.BAD_REQUEST, details);
  }
}
