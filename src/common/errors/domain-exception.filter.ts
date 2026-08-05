import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from './domain.exception';
import { ErrorCode } from './error-code';

interface ErrorBody {
  status: number;
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

const STATUS_CODES: Record<number, ErrorCode> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
};

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const body = this.toBody(exception);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(body.status)
      .json({ error: { code: body.code, message: body.message, details: body.details } });
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof DomainException) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) return this.fromHttpException(exception);

    this.logger.error(
      exception instanceof Error ? exception.message : 'Unhandled exception',
      exception instanceof Error ? exception.stack : undefined,
    );
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      details: {},
    };
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const code = STATUS_CODES[status] ?? 'INTERNAL_ERROR';

    if (typeof payload === 'string') return { status, code, message: payload, details: {} };

    const { message, statusCode, error, ...rest } = payload as Record<string, unknown>;
    const details = Array.isArray(message) ? { ...rest, violations: message } : rest;

    return {
      status,
      code,
      message: Array.isArray(message) ? 'Request validation failed' : String(message ?? error),
      details,
    };
  }
}
