import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Inject, Param, Patch, type PipeTransform, Post, UseGuards } from '@nestjs/common';
import {
  dispatchResponseSchema,
  messageSchema,
  okResponseSchema,
  scheduledMessageSchema,
  scheduledMessagesResponseSchema,
  scheduleMessageBodySchema,
  updateScheduledBodySchema,
} from '@bedo/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DISPATCH_HEADER, ScheduledService } from './scheduled.service.js';
import { MonitoringService } from '../runtime/monitoring.service.js';

const uuid = z.string().uuid();

class IdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = uuid.safeParse(value);
    if (!result.success) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return result.data;
  }
}

/** Phase 6: scheduling a message in a chat, and the author's list of them there (D-40). */
@Controller('v1/chats')
@UseGuards(UserAuthGuard)
export class ChatScheduledController {
  constructor(@Inject(ScheduledService) private readonly scheduled: ScheduledService) {}

  @Post(':id/scheduled')
  @HttpCode(200)
  @ResponseSchema(scheduledMessageSchema)
  schedule(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(scheduleMessageBodySchema)) body: z.infer<typeof scheduleMessageBodySchema>) {
    return this.scheduled.schedule(auth, id, body);
  }

  @Get(':id/scheduled')
  @ResponseSchema(scheduledMessagesResponseSchema)
  async list(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return { scheduled: await this.scheduled.list(auth.userId, id) };
  }
}

/** Phase 6: one scheduled message (its author only). */
@Controller('v1/scheduled')
@UseGuards(UserAuthGuard)
export class ScheduledController {
  constructor(@Inject(ScheduledService) private readonly scheduled: ScheduledService) {}

  @Patch(':id')
  @ResponseSchema(scheduledMessageSchema)
  update(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(updateScheduledBodySchema)) body: z.infer<typeof updateScheduledBodySchema>) {
    return this.scheduled.update(auth, id, body);
  }

  @Delete(':id')
  @ResponseSchema(okResponseSchema)
  async cancel(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    await this.scheduled.cancel(auth, id);
    return { ok: true } as const;
  }

  @Post(':id/send')
  @HttpCode(200)
  @ResponseSchema(messageSchema)
  sendNow(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.scheduled.sendNow(auth, id);
  }
}

/**
 * Phase 6: the scheduled Netlify function (apps/web/netlify/functions/scheduler.mts) calls this every minute. Only a
 * request carrying the dispatch token is served; anyone else gets 404, as if the route did not exist.
 */
@Controller('v1/internal')
export class InternalDispatchController {
  constructor(
    @Inject(ScheduledService) private readonly scheduled: ScheduledService,
    @Inject(MonitoringService) private readonly monitoring: MonitoringService,
  ) {}

  @Post('dispatch')
  @HttpCode(200)
  @ResponseSchema(dispatchResponseSchema)
  async dispatch(@Headers(DISPATCH_HEADER) token: string | undefined) {
    if (!this.scheduled.isDispatchToken(token)) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    // Phase 14.5: this minute call also is the site monitoring's check (it came in through the public address).
    await this.monitoring.heartbeat();
    return this.scheduled.dispatchDue();
  }
}
