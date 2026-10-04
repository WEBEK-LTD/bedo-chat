import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ErrorCode, ErrorEnvelope } from '@bedo/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './app-error.js';
import { RequestValidationException } from './zod-validation.pipe.js';

const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_FAILED',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.METHOD_NOT_ALLOWED]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.GONE]: 'NOT_FOUND',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'VALIDATION_FAILED',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'VALIDATION_FAILED',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'VALIDATION_FAILED',
  [HttpStatus.TOO_MANY_REQUESTS]: 'RATE_LIMITED',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'SERVICE_UNAVAILABLE',
};

const SAFE_MESSAGES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: 'The request is not valid.',
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_FOUND: 'Not found.',
  CONFLICT: 'The request conflicts with the current state.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',
  INTERNAL: 'Something went wrong.',
  OTP_INVALID: 'The code is incorrect or has expired.',
  OTP_LOCKED: 'Too many incorrect codes. Request a new code.',
  TWO_STEP_INVALID: 'The password is incorrect.',
  TWO_STEP_REQUIRED: 'Your 2-Step Verification password is required.',
  TOTP_INVALID: 'The authenticator code is incorrect.',
  SESSION_INVALID: 'Your session has ended. Sign in again.',
  ACCOUNT_DELETED: 'This account has been deleted.',
  ACCOUNT_BLOCKED: 'This account cannot be used. Contact the academy.',
  USERNAME_TAKEN: 'This username is already taken.',
  CSRF_REJECTED: 'The request was rejected.',
};

/**
 * Converts every error into the shared ErrorEnvelope. Messages are fixed per error code so
 * internal details (SQL, stack traces, other users' data) never reach a client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    // HTTP only. The realtime gateway (Phase 3) gets its own filter with its own error shape.
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
    } else if (isFastifyClientError(exception)) {
      status = exception.statusCode;
    }
    const code: ErrorCode =
      exception instanceof AppError
        ? exception.code
        : (CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL' : 'VALIDATION_FAILED'));

    if (status >= 500) {
      this.logger.error(
        `Unhandled error on ${request.method} ${request.url} [${request.id}]`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorEnvelope = {
      error: {
        code,
        message: SAFE_MESSAGES[code],
        requestId: String(request.id),
        ...(exception instanceof RequestValidationException ? { fields: exception.fields } : {}),
        ...(exception instanceof AppError && exception.retryAfterSeconds
          ? { retryAfterSeconds: exception.retryAfterSeconds }
          : {}),
      },
    };
    if (exception instanceof AppError && exception.retryAfterSeconds) {
      void reply.header('retry-after', String(exception.retryAfterSeconds));
    }
    void reply.status(status).send(body);
  }
}

function isFastifyClientError(error: unknown): error is { statusCode: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof (error as { statusCode: unknown }).statusCode === 'number' &&
    (error as { statusCode: number }).statusCode >= 400 &&
    (error as { statusCode: number }).statusCode < 500
  );
}
