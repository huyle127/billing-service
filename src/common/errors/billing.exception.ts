import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-code';

/**
 * Base class for every error the service raises deliberately. Carrying the
 * {@link ErrorCode} on the exception is what lets the global filter emit one
 * uniform shape without each handler formatting its own response.
 */
export class BillingException extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus,
    readonly details?: unknown,
  ) {
    super(message, status);
  }
}
