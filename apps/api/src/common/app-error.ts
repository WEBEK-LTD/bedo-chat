import { HttpException, type HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@bedo/contracts';

/**
 * An expected failure with a specific error code. The message sent to the client is the fixed text
 * for that code (see AllExceptionsFilter); `retryAfterSeconds` is passed on for rate limits.
 */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code, status);
  }
}
