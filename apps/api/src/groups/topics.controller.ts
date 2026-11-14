import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, type PipeTransform, Post, UseGuards } from '@nestjs/common';
import { createTopicBodySchema, groupTopicSchema, groupTopicsResponseSchema, topicSettingsBodySchema, updateTopicBodySchema } from '@bedo/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { TopicsService } from './topics.service.js';

const uuid = z.string().uuid();

class IdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = uuid.safeParse(value);
    if (!result.success) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return result.data;
  }
}

/** D-63: topics in groups. */
@Controller('v1/groups/:id/topics')
@UseGuards(UserAuthGuard)
export class TopicsController {
  constructor(@Inject(TopicsService) private readonly topics: TopicsService) {}

  @Get()
  @ResponseSchema(groupTopicsResponseSchema)
  list(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.topics.list(auth.userId, id);
  }

  @Patch()
  @ResponseSchema(groupTopicsResponseSchema)
  settings(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(topicSettingsBodySchema)) body: z.infer<typeof topicSettingsBodySchema>) {
    return this.topics.setEnabled(auth, id, body.enabled);
  }

  @Post()
  @HttpCode(200)
  @ResponseSchema(groupTopicSchema)
  create(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(createTopicBodySchema)) body: z.infer<typeof createTopicBodySchema>) {
    return this.topics.create(auth, id, body);
  }

  @Patch(':topicId')
  @ResponseSchema(groupTopicSchema)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new IdPipe()) id: string,
    @Param('topicId', new IdPipe()) topicId: string,
    @Body(new ZodValidationPipe(updateTopicBodySchema)) body: z.infer<typeof updateTopicBodySchema>,
  ) {
    return this.topics.update(auth, id, topicId, body);
  }

  @Post(':topicId/close')
  @HttpCode(200)
  @ResponseSchema(groupTopicSchema)
  close(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Param('topicId', new IdPipe()) topicId: string) {
    return this.topics.setClosed(auth, id, topicId, true);
  }

  @Post(':topicId/reopen')
  @HttpCode(200)
  @ResponseSchema(groupTopicSchema)
  reopen(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Param('topicId', new IdPipe()) topicId: string) {
    return this.topics.setClosed(auth, id, topicId, false);
  }
}
