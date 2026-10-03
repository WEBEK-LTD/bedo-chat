import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

export interface FieldError {
  path: string;
  message: string;
}

export class RequestValidationException extends BadRequestException {
  constructor(readonly fields: FieldError[]) {
    super('Request validation failed');
  }
}

/** Validates a request body, query or params object against a contract schema. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    throw new RequestValidationException(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
}
