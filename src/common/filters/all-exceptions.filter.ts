import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BillingException } from '../errors/billing.exception';
import { ErrorCode } from '../errors/error-code';
import { isDatabaseError, isTransientDatabaseError } from '../prisma-errors';

export interface ErrorResponseBody {
  statusCode: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  path: string;
  timestamp: string;
}

/** Statuses at or above this are our fault, so they get logged with a stack. */
const SERVER_ERROR_STATUS = 500;

const STATUS_TO_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.ValidationFailed,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.Unauthenticated,
  [HttpStatus.FORBIDDEN]: ErrorCode.Forbidden,
  [HttpStatus.NOT_FOUND]: ErrorCode.NotFound,
  [HttpStatus.CONFLICT]: ErrorCode.Conflict,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RateLimited,
};

/**
 * Renders every error in one shape: a machine-readable code, a human-readable
 * message, and no internal stack detail (`billing-history` → "Error shape is
 * uniform"). Stack traces are logged server-side rather than returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const body = this.toBody(exception, request.url);

    if (body.statusCode >= SERVER_ERROR_STATUS) {
      this.logger.error(
        `${request.method} ${request.url} -> ${body.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, path: string): ErrorResponseBody {
    const timestamp = new Date().toISOString();

    if (exception instanceof BillingException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
        path,
        timestamp,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();
      return {
        statusCode,
        code: STATUS_TO_CODE[statusCode] ?? ErrorCode.InternalError,
        message: this.messageOf(payload, exception.message),
        details: this.detailsOf(payload),
        path,
        timestamp,
      };
    }

    if (isDatabaseError(exception)) {
      // A database refusal that no flow above expected. Reported as what it is
      // — the database declined the write — rather than as a generic fault,
      // because "the constraint is the arbiter" is only a useful principle if
      // the caller is told when a constraint spoke. The message carries no
      // table, column, or constraint name.
      return {
        statusCode: isTransientDatabaseError(exception)
          ? HttpStatus.SERVICE_UNAVAILABLE
          : HttpStatus.INTERNAL_SERVER_ERROR,
        code: ErrorCode.DatabaseTransactionFailed,
        message: 'The database could not complete this operation.',
        path,
        timestamp,
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.InternalError,
      message: 'An unexpected error occurred.',
      path,
      timestamp,
    };
  }

  /**
   * `ValidationPipe` puts its per-field failures in `message` as an array; that
   * belongs in `details`, with a single summary sentence as the message.
   */
  private messageOf(payload: string | object, fallback: string): string {
    if (typeof payload === 'string') {
      return payload;
    }
    const message = (payload as { message?: unknown }).message;
    if (Array.isArray(message)) {
      return 'Request validation failed.';
    }
    return typeof message === 'string' ? message : fallback;
  }

  private detailsOf(payload: string | object): unknown {
    if (typeof payload === 'string') {
      return undefined;
    }
    const message = (payload as { message?: unknown }).message;
    return Array.isArray(message) ? message : undefined;
  }
}
