import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, type PipeTransform, Post, Query, UseGuards } from '@nestjs/common';
import {
  addMembersBodySchema,
  addMembersResponseSchema,
  channelSearchQuerySchema,
  channelSearchResponseSchema,
  chatSchema,
  createChannelBodySchema,
  createGroupBodySchema,
  createInviteLinkBodySchema,
  groupMembersQuerySchema,
  groupMembersResponseSchema,
  groupSettingsBodySchema,
  inviteCodeSchema,
  inviteLinkSchema,
  inviteLinksResponseSchema,
  invitePreviewSchema,
  joinRequestsResponseSchema,
  joinResponseSchema,
  messageSchema,
  okResponseSchema,
  photoConfirmBodySchema,
  photoUploadBodySchema,
  photoUploadResponseSchema,
  pollVoteBodySchema,
  pollVotersResponseSchema,
  transferOwnershipBodySchema,
  updateGroupBodySchema,
  updateMemberBodySchema,
  userPermissionsSchema,
} from '@bedo/contracts';
import { z } from 'zod';
import { type AuthContext, CurrentAuth, UserAuthGuard } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DatabaseService } from '../database/database.service.js';
import { MessagesService } from '../messaging/messages.service.js';
import { GroupsService } from './groups.service.js';
import { PollsService } from './polls.service.js';
import { UserPermissionsService } from './user-permissions.service.js';

const uuid = z.string().uuid();
const OK = { ok: true } as const;

class IdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = uuid.safeParse(value);
    if (!result.success) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return result.data;
  }
}

class CodePipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const result = inviteCodeSchema.safeParse(value);
    if (!result.success) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return result.data;
  }
}

/** Phase 5: groups (D-39). */
@Controller('v1/groups')
@UseGuards(UserAuthGuard)
export class GroupsController {
  constructor(@Inject(GroupsService) private readonly groups: GroupsService) {}

  @Post()
  @HttpCode(200)
  @ResponseSchema(chatSchema)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createGroupBodySchema)) body: z.infer<typeof createGroupBodySchema>) {
    return this.groups.create(auth, body);
  }

  @Patch(':id')
  @ResponseSchema(chatSchema)
  update(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(updateGroupBodySchema)) body: z.infer<typeof updateGroupBodySchema>) {
    return this.groups.update(auth, id, body);
  }

  @Delete(':id')
  @ResponseSchema(okResponseSchema)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    await this.groups.deleteGroup(auth, id);
    return OK;
  }

  @Patch(':id/settings')
  @ResponseSchema(chatSchema)
  settings(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(groupSettingsBodySchema)) body: z.infer<typeof groupSettingsBodySchema>) {
    return this.groups.updateSettings(auth, id, body);
  }

  @Post(':id/photo/upload')
  @HttpCode(200)
  @ResponseSchema(photoUploadResponseSchema)
  photoUpload(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(photoUploadBodySchema)) body: z.infer<typeof photoUploadBodySchema>) {
    return this.groups.startPhotoUpload(auth, id, body.contentType);
  }

  @Post(':id/photo/confirm')
  @HttpCode(200)
  @ResponseSchema(chatSchema)
  photoConfirm(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(photoConfirmBodySchema)) body: { uploadId: string }) {
    return this.groups.confirmPhoto(auth, id, body.uploadId);
  }

  @Delete(':id/photo')
  @ResponseSchema(chatSchema)
  removePhoto(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.groups.setPhoto(auth, id, null);
  }

  @Get(':id/members')
  @ResponseSchema(groupMembersResponseSchema)
  members(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Query(new ZodValidationPipe(groupMembersQuerySchema)) query: z.infer<typeof groupMembersQuerySchema>) {
    return this.groups.members(auth.userId, id, query.after);
  }

  @Post(':id/members')
  @HttpCode(200)
  @ResponseSchema(addMembersResponseSchema)
  addMembers(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(addMembersBodySchema)) body: z.infer<typeof addMembersBodySchema>) {
    return this.groups.addMembers(auth, id, body.userIds);
  }

  @Patch(':id/members/:userId')
  @ResponseSchema(okResponseSchema)
  async updateMember(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new IdPipe()) id: string,
    @Param('userId', new IdPipe()) userId: string,
    @Body(new ZodValidationPipe(updateMemberBodySchema)) body: z.infer<typeof updateMemberBodySchema>,
  ) {
    await this.groups.updateMember(auth, id, userId, body);
    return OK;
  }

  @Delete(':id/members/:userId')
  @ResponseSchema(okResponseSchema)
  async removeMember(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Param('userId', new IdPipe()) userId: string) {
    await this.groups.removeMember(auth, id, userId);
    return OK;
  }

  @Post(':id/owner')
  @HttpCode(200)
  @ResponseSchema(chatSchema)
  transfer(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(transferOwnershipBodySchema)) body: z.infer<typeof transferOwnershipBodySchema>) {
    return this.groups.transferOwnership(auth, id, body.userId);
  }

  @Post(':id/leave')
  @HttpCode(200)
  @ResponseSchema(okResponseSchema)
  async leave(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    await this.groups.leave(auth, id);
    return OK;
  }

  @Get(':id/invites')
  @ResponseSchema(inviteLinksResponseSchema)
  async invites(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return { links: await this.groups.inviteLinks(auth.userId, id) };
  }

  @Post(':id/invites')
  @HttpCode(200)
  @ResponseSchema(inviteLinkSchema)
  createInvite(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(createInviteLinkBodySchema)) body: z.infer<typeof createInviteLinkBodySchema>) {
    return this.groups.createInviteLink(auth, id, body);
  }

  @Delete(':id/invites/:linkId')
  @ResponseSchema(inviteLinksResponseSchema)
  async revokeInvite(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Param('linkId', new IdPipe()) linkId: string) {
    return { links: await this.groups.revokeInviteLink(auth, id, linkId) };
  }

  @Get(':id/requests')
  @ResponseSchema(joinRequestsResponseSchema)
  async requests(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return { requests: await this.groups.joinRequests(auth.userId, id) };
  }

  @Post(':id/requests/:requestId/approve')
  @HttpCode(200)
  @ResponseSchema(joinRequestsResponseSchema)
  async approve(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Param('requestId', new IdPipe()) requestId: string) {
    return { requests: await this.groups.decideRequest(auth, id, requestId, true) };
  }

  @Post(':id/requests/:requestId/decline')
  @HttpCode(200)
  @ResponseSchema(joinRequestsResponseSchema)
  async decline(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Param('requestId', new IdPipe()) requestId: string) {
    return { requests: await this.groups.decideRequest(auth, id, requestId, false) };
  }
}

/** Phase 6: channels (D-40). Managing one uses the groups' endpoints (/v1/groups/:id/...). */
@Controller('v1/channels')
@UseGuards(UserAuthGuard)
export class ChannelsController {
  constructor(@Inject(GroupsService) private readonly groups: GroupsService) {}

  @Post()
  @HttpCode(200)
  @ResponseSchema(chatSchema)
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodValidationPipe(createChannelBodySchema)) body: z.infer<typeof createChannelBodySchema>) {
    return this.groups.createChannel(auth, body);
  }

  @Get('search')
  @ResponseSchema(channelSearchResponseSchema)
  async search(@CurrentAuth() auth: AuthContext, @Query(new ZodValidationPipe(channelSearchQuerySchema)) query: z.infer<typeof channelSearchQuerySchema>) {
    return { channels: await this.groups.searchChannels(auth.userId, query.q) };
  }

  @Post(':id/join')
  @HttpCode(200)
  @ResponseSchema(chatSchema)
  join(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.groups.joinChannel(auth, id);
  }
}

/** Phase 5: joining a group with an invite link (https://bedochat.com/?join=<code>). */
@Controller('v1/invites')
@UseGuards(UserAuthGuard)
export class InvitesController {
  constructor(@Inject(GroupsService) private readonly groups: GroupsService) {}

  @Get(':code')
  @ResponseSchema(invitePreviewSchema)
  preview(@CurrentAuth() auth: AuthContext, @Param('code', new CodePipe()) code: string) {
    return this.groups.preview(auth.userId, code);
  }

  @Post(':code/join')
  @HttpCode(200)
  @ResponseSchema(joinResponseSchema)
  join(@CurrentAuth() auth: AuthContext, @Param('code', new CodePipe()) code: string) {
    return this.groups.join(auth, code);
  }
}

/** Phase 5: polls and quizzes. */
@Controller('v1/messages')
@UseGuards(UserAuthGuard)
export class PollsController {
  constructor(
    @Inject(PollsService) private readonly polls: PollsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private view = (viewerId: string) => async (messageId: string) => {
    const [message] = await this.messages.visibleViews(this.database.db, viewerId, [messageId]);
    if (!message) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    return message;
  };

  @Post(':id/poll/vote')
  @HttpCode(200)
  @ResponseSchema(messageSchema)
  vote(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string, @Body(new ZodValidationPipe(pollVoteBodySchema)) body: z.infer<typeof pollVoteBodySchema>) {
    return this.polls.vote(auth, id, body.options, this.view(auth.userId));
  }

  @Delete(':id/poll/vote')
  @ResponseSchema(messageSchema)
  retract(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.polls.vote(auth, id, null, this.view(auth.userId));
  }

  @Post(':id/poll/close')
  @HttpCode(200)
  @ResponseSchema(messageSchema)
  close(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.polls.close(auth, id, this.view(auth.userId));
  }

  @Get(':id/poll/voters')
  @ResponseSchema(pollVotersResponseSchema)
  voters(@CurrentAuth() auth: AuthContext, @Param('id', new IdPipe()) id: string) {
    return this.polls.voters(auth.userId, id);
  }
}

/** Phase 5: what the signed-in user may create (O-21). */
@Controller('v1/me')
@UseGuards(UserAuthGuard)
export class MyPermissionsController {
  constructor(
    @Inject(UserPermissionsService) private readonly permissions: UserPermissionsService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  @Get('permissions')
  @ResponseSchema(userPermissionsSchema)
  get(@CurrentAuth() auth: AuthContext) {
    return this.permissions.forUser(this.database.db, auth.userId);
  }
}
