import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import {
  addStickerBodySchema,
  adminStickerImageResponseSchema,
  adminStickerPacksResponseSchema,
  createStickerPackBodySchema,
  gifSettingsBodySchema,
  gifSettingsResponseSchema,
  updateStickerPackBodySchema,
} from '@bedo/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../common/app-error.js';
import { requestInfo } from '../common/request-info.js';
import { ResponseSchema } from '../common/response-schema.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { GifsService } from '../media/gifs.service.js';
import { StickersService } from '../media/stickers.service.js';
import { AdminAuthGuard, AdminRoles, CurrentAdmin } from './admin-auth.guard.js';
import type { AdminContext } from './admin-auth.service.js';

const uuid = z.string().uuid();
const id = (value: string): string => {
  if (!uuid.safeParse(value).success) {
    throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
  }
  return value;
};

/** Phase 4: sticker packs (O-10) and the GIPHY key (O-09). Every admin reads; Super Admins change. */
@Controller('v1/admin')
@UseGuards(AdminAuthGuard)
export class AdminMediaController {
  constructor(
    @Inject(StickersService) private readonly stickers: StickersService,
    @Inject(GifsService) private readonly gifs: GifsService,
  ) {}

  @Get('stickers')
  @ResponseSchema(adminStickerPacksResponseSchema)
  list() {
    return this.stickers.adminList();
  }

  @Get('stickers/:id/image')
  @ResponseSchema(adminStickerImageResponseSchema)
  image(@Param('id') stickerId: string) {
    return this.stickers.adminImage(id(stickerId));
  }

  @Post('stickers/packs')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(adminStickerPacksResponseSchema)
  createPack(@CurrentAdmin() admin: AdminContext, @Body(new ZodValidationPipe(createStickerPackBodySchema)) body: z.infer<typeof createStickerPackBodySchema>, @Req() request: FastifyRequest) {
    return this.stickers.createPack(admin.adminId, body.name, requestInfo(request));
  }

  @Patch('stickers/packs/:id')
  @AdminRoles('super_admin')
  @ResponseSchema(adminStickerPacksResponseSchema)
  updatePack(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') packId: string,
    @Body(new ZodValidationPipe(updateStickerPackBodySchema)) body: z.infer<typeof updateStickerPackBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    return this.stickers.updatePack(admin.adminId, id(packId), body, requestInfo(request));
  }

  @Post('stickers/packs/:id/stickers')
  @HttpCode(200)
  @AdminRoles('super_admin')
  @ResponseSchema(adminStickerPacksResponseSchema)
  addSticker(
    @CurrentAdmin() admin: AdminContext,
    @Param('id') packId: string,
    @Body(new ZodValidationPipe(addStickerBodySchema)) body: z.infer<typeof addStickerBodySchema>,
    @Req() request: FastifyRequest,
  ) {
    return this.stickers.addSticker(admin.adminId, id(packId), body.emoji, body.data, requestInfo(request));
  }

  @Delete('stickers/:id')
  @AdminRoles('super_admin')
  @ResponseSchema(adminStickerPacksResponseSchema)
  removeSticker(@CurrentAdmin() admin: AdminContext, @Param('id') stickerId: string, @Req() request: FastifyRequest) {
    return this.stickers.removeSticker(admin.adminId, id(stickerId), requestInfo(request));
  }

  @Get('settings/gifs')
  @ResponseSchema(gifSettingsResponseSchema)
  gifSettings() {
    return this.gifs.settings();
  }

  @Put('settings/gifs')
  @AdminRoles('super_admin')
  @ResponseSchema(gifSettingsResponseSchema)
  setGifKey(@CurrentAdmin() admin: AdminContext, @Body(new ZodValidationPipe(gifSettingsBodySchema)) body: z.infer<typeof gifSettingsBodySchema>, @Req() request: FastifyRequest) {
    return this.gifs.setKey(admin.adminId, body.apiKey, requestInfo(request));
  }
}
