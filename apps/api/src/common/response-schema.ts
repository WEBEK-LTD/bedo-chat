import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ZodType } from 'zod';
import { map, type Observable } from 'rxjs';

const RESPONSE_SCHEMA = 'bedo:response-schema';

/**
 * Declares the contract schema for a route's response body. Every route must have one:
 * the interceptor passes the handler's return value through the schema, which drops any field
 * the contract does not list. This is how data a caller is not allowed to see (for example
 * hidden group members, spec §7) is kept out of responses by construction.
 */
export const ResponseSchema = (schema: ZodType) => SetMetadata(RESPONSE_SCHEMA, schema);

@Injectable()
export class ResponseSchemaInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ResponseSchemaInterceptor.name);

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.getAllAndOverride<ZodType | undefined>(RESPONSE_SCHEMA, [
      context.getHandler(),
      context.getClass(),
    ]);
    const route = `${context.getClass().name}.${context.getHandler().name}`;
    if (!schema) {
      this.logger.error(`Route ${route} has no @ResponseSchema; refusing to send an unvalidated response`);
      throw new InternalServerErrorException();
    }
    return next.handle().pipe(
      map((body: unknown) => {
        const result = schema.safeParse(body);
        if (!result.success) {
          this.logger.error(`Response from ${route} does not match its contract: ${result.error.message}`);
          throw new InternalServerErrorException();
        }
        return result.data;
      }),
    );
  }
}
