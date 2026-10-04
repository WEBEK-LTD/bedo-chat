import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, type PipeTransform, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  chatSchema,
  chatSearchQuerySchema,
  chatsResponseSchema,
  chatStateBodySchema,
  createChatBodySchema,
  createFolderBodySchema,
  type DeleteMessagesBody,
  deleteMessagesBodySchema,
  editMessageBodySchema,
  foldersResponseSchema,
  type ForwardMessagesBody,
  forwardMessagesBodySchema,
  messageHistoryQuerySchema,
  messageSchema,
  messagesResponseSchema,
  okResponseSchema,
  peerSchema,
  readChatBodySchema,
  type ReportBody,
  reportBodySchema,
  screenshotEventBodySchema,
  type SendMessageBody,
  sendMessageBodySchema,
  syncQuerySchema,
  syncResponseSchema,
  updateFolderBodySchema,
  userSearchQuerySchema,
  userSearchResponseSchema,
} from '@bedo/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ChatsService } from './chats.service.js';
import { FoldersService } from './folders.service.js';
import { MessagesService } from './messages.service.js';
import { SafetyService } from './safety.service.js';
import { SyncService } from './sync.service.js';
import { UsersService } from './users.service.js';

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

const OK = { ok: true } as const;

/** Finding users to start a chat (P-25), their profiles, blocks (P-26, P-30). */
@Controller('v1/users')
@UseGuards(UserAuthGuard)
export class UsersController {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SafetyService) private readonly safety: SafetyService,
  ) {}

  @Get('search')
  @ResponseSchema(userSearchResponseSchema)
  async search(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(userSearchQuerySchema)) query: z.infer<typeof userSearchQuerySchema>) {
    return { users: await this.users.search(auth.userId, query.q) };
  }

  @Get(':id')
  @ResponseSchema(peerSchema)
  profile(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.users.profile(auth.userId, id);
  }

  @Post(':id/block')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async block(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    await this.safety.setBlocked(auth.userId, id, true);
    return OK;
  }

  @Delete(':id/block')
  @ResponseSchema(okResponseSchema)
  async unblock(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    await this.safety.setBlocked(auth.userId, id, false);
    return OK;
  }
}

/** Private chats: list, history, sending, read and delivered positions, chat-list state, search. */
@Controller('v1/chats')
@UseGuards(UserAuthGuard)
export class ChatsController {
  constructor(
    @Inject(ChatsService) private readonly chats: ChatsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
  ) {}

  @Get()
  @ResponseSchema(chatsResponseSchema)
  async list(@CurrentAuth() auth: AuthContext) {
    return { chats: await this.chats.list(auth.userId) };
  }

  @Post()
  @HttpCode(200)
  @ResponseSchema(chatSchema)
  open(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createChatBodySchema)) body: z.infer<typeof createChatBodySchema>) {
    return this.chats.open(auth.userId, body.userId);
  }

  @Get(':id')
  @ResponseSchema(chatSchema)
  get(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.chats.get(auth.userId, id);
  }

  @Get(':id/messages')
  @ResponseSchema(messagesResponseSchema)
  async history(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new IdPipe()) id: string,
    @Query(new ZodValidationPipe(messageHistoryQuerySchema)) query: z.infer<typeof messageHistoryQuerySchema>,
  ) {
    return { messages: await this.messages.history(auth.userId, id, query) };
  }

  @Post(':id/messages')
  @HttpCode(200)
  @ResponseSchema(messageSchema)
  send(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(sendMessageBodySchema)) body: SendMessageBody) {
    return this.messages.send(auth, id, body);
  }

  @Get(':id/search')
  @ResponseSchema(messagesResponseSchema)
  async search(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new IdPipe()) id: string,
    @Query(new ZodValidationPipe(chatSearchQuerySchema)) query: z.infer<typeof chatSearchQuerySchema>,
  ) {
    return { messages: await this.messages.search(auth.userId, id, query.q, query.before) };
  }

  @Get(':id/pins')
  @ResponseSchema(messagesResponseSchema)
  async pins(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return { messages: await this.messages.pins(auth.userId, id) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ResponseSchema(chatSchema)
  read(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(readChatBodySchema)) body: z.infer<typeof readChatBodySchema>) {
    return this.chats.read(auth.userId, id, body.seq);
  }

  @Post(':id/delivered')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async delivered(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(readChatBodySchema)) body: z.infer<typeof readChatBodySchema>) {
    await this.chats.delivered(auth.userId, id, body.seq);
    return OK;
  }

  @Patch(':id/state')
  @ResponseSchema(chatSchema)
  state(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(chatStateBodySchema)) body: z.infer<typeof chatStateBodySchema>) {
    return this.chats.setState(auth.userId, id, body);
  }
}

/** Changes to existing messages: edit, delete, forward, pin. */
@Controller('v1/messages')
@UseGuards(UserAuthGuard)
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService) {}

  @Patch(':id')
  @ResponseSchema(messageSchema)
  edit(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(editMessageBodySchema)) body: z.infer<typeof editMessageBodySchema>) {
    return this.messages.edit(auth, id, body.text);
  }

  @Post('delete')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async delete(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(deleteMessagesBodySchema)) body: DeleteMessagesBody) {
    await this.messages.delete(auth, body);
    return OK;
  }

  @Post('forward')
  @HttpCode(200)
  @ResponseSchema(messagesResponseSchema)
  async forward(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(forwardMessagesBodySchema)) body: ForwardMessagesBody) {
    return { messages: await this.messages.forward(auth, body) };
  }

  @Put(':id/pin')
  @ResponseSchema(messageSchema)
  pin(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.messages.setPinned(auth, id, true);
  }

  @Delete(':id/pin')
  @ResponseSchema(messageSchema)
  unpin(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.messages.setPinned(auth, id, false);
  }
}

/** Chat folders (P-21). */
@Controller('v1/folders')
@UseGuards(UserAuthGuard)
export class FoldersController {
  constructor(@Inject(FoldersService) private readonly folders: FoldersService) {}

  @Get()
  @ResponseSchema(foldersResponseSchema)
  async list(@CurrentAuth() auth: AuthContext) {
    return { folders: await this.folders.listMine(auth.userId) };
  }

  @Post()
  @HttpCode(200)
  @ResponseSchema(foldersResponseSchema)
  async create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createFolderBodySchema)) body: z.infer<typeof createFolderBodySchema>) {
    return { folders: await this.folders.create(auth.userId, body) };
  }

  @Patch(':id')
  @ResponseSchema(foldersResponseSchema)
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new IdPipe()) id: string,
    @Body(new ZodValidationPipe(updateFolderBodySchema)) body: z.infer<typeof updateFolderBodySchema>,
  ) {
    return { folders: await this.folders.update(auth.userId, id, body) };
  }

  @Delete(':id')
  @ResponseSchema(foldersResponseSchema)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return { folders: await this.folders.remove(auth.userId, id) };
  }
}

/** Reports (P-27), screenshot intake (P-28) and sync (P-17). */
@Controller('v1')
@UseGuards(UserAuthGuard)
export class SafetyAndSyncController {
  constructor(
    @Inject(SafetyService) private readonly safety: SafetyService,
    @Inject(SyncService) private readonly sync: SyncService,
  ) {}

  @Post('reports')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async report(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(reportBodySchema)) body: ReportBody) {
    await this.safety.report(auth.userId, body);
    return OK;
  }

  @Post('screenshot-events')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async screenshot(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(screenshotEventBodySchema)) body: z.infer<typeof screenshotEventBodySchema>) {
    await this.safety.screenshot(auth, body);
    return OK;
  }

  @Get('sync')
  @ResponseSchema(syncResponseSchema)
  updates(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(syncQuerySchema)) query: z.infer<typeof syncQuerySchema>) {
    return this.sync.since(auth.userId, query.since);
  }
}
