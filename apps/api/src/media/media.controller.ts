import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, type PipeTransform, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import {
  chatMediaQuerySchema,
  fileUrlQuerySchema,
  fileUrlResponseSchema,
  gifPreviewQuerySchema,
  gifSearchQuerySchema,
  gifSearchResponseSchema,
  messageSchema,
  messagesResponseSchema,
  reactionBodySchema,
  stickerPacksResponseSchema,
  type UploadRequestBody,
  uploadRequestBodySchema,
  uploadResponseSchema,
} from '@bedo/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MessagingLimitsService } from '../messaging/messaging-limits.service.js';
import { FilesService } from './files.service.js';
import { GifsService } from './gifs.service.js';
import { ReactionsService } from './reactions.service.js';
import { StickersService } from './stickers.service.js';

const uuid = z.string().uuid();

/** An id in the path that is not a UUID cannot name anything: 404, like an id that does not exist. */
class IdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = uuid.safeParse(value);
    if (!result.success) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    return result.data;
  }
}

/** The binary body of the GIF preview route (an image), passed through unchanged. */
export const binaryBodySchema = z.custom<Buffer>((value) => Buffer.isBuffer(value));

/** Phase 4: upload slots for files sent in chats. */
@Controller('v1/files')
@UseGuards(UserAuthGuard)
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post('uploads')
  @HttpCode(200)
  @ResponseSchema(uploadResponseSchema)
  upload(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(uploadRequestBodySchema)) body: UploadRequestBody) {
    return this.files.createUpload(auth, body);
  }
}

/** Phase 4: a message's file and reactions. */
@Controller('v1/messages')
@UseGuards(UserAuthGuard)
export class MessageMediaController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ReactionsService) private readonly reactions: ReactionsService,
  ) {}

  @Get(':id/file')
  @ResponseSchema(fileUrlResponseSchema)
  file(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Query(new ZodValidationPipe(fileUrlQuerySchema)) query: z.infer<typeof fileUrlQuerySchema>) {
    return this.files.fileUrl(auth.userId, id, query.download === 'true');
  }

  @Put(':id/reaction')
  @ResponseSchema(messageSchema)
  react(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(reactionBodySchema)) body: z.infer<typeof reactionBodySchema>) {
    return this.reactions.set(auth, id, body.emoji);
  }

  @Delete(':id/reaction')
  @ResponseSchema(messageSchema)
  unreact(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.reactions.set(auth, id, null);
  }
}

/** Phase 4: a chat's media panel. */
@Controller('v1/chats')
@UseGuards(UserAuthGuard)
export class ChatMediaController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get(':id/media')
  @ResponseSchema(messagesResponseSchema)
  async media(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Query(new ZodValidationPipe(chatMediaQuerySchema)) query: z.infer<typeof chatMediaQuerySchema>) {
    return { messages: await this.files.media(auth.userId, id, query.kind, query.before) };
  }
}

/** Phase 4: sticker packs to pick from (O-10). */
@Controller('v1/stickers')
@UseGuards(UserAuthGuard)
export class StickersController {
  constructor(@Inject(StickersService) private readonly stickers: StickersService) {}

  @Get()
  @ResponseSchema(stickerPacksResponseSchema)
  async list() {
    return { packs: await this.stickers.available() };
  }
}

/** Phase 4: GIF search (O-09). */
@Controller('v1/gifs')
export class GifsController {
  constructor(
    @Inject(GifsService) private readonly gifs: GifsService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
  ) {}

  @Get('search')
  @UseGuards(UserAuthGuard)
  @ResponseSchema(gifSearchResponseSchema)
  async search(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(gifSearchQuerySchema)) query: z.infer<typeof gifSearchQuerySchema>) {
    await this.limits.gifSearches(auth.userId);
    return this.gifs.search(query.q, query.offset ?? 0);
  }

  /**
   * A GIF preview image. Pictures cannot send the access token, so the link itself is the permission: the API signs
   * each one it hands out (valid an hour) and serves only GIPHY media addresses it signed.
   */
  @Get('preview')
  @ResponseSchema(binaryBodySchema)
  async preview(@Query(new ZodValidationPipe(gifPreviewQuerySchema)) query: z.infer<typeof gifPreviewQuerySchema>, @Res({ passthrough: true }) reply: FastifyReply) {
    const image = await this.gifs.preview(query.u, query.e, query.s);
    void reply.header('content-type', image.contentType).header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff');
    return image.body;
  }
}
