import { Controller, Get, Inject } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { pushConfigResponseSchema } from '@bedo/contracts';
import { ResponseSchema } from '../common/response-schema.js';
import { API_ENV } from '../config/tokens.js';

/** The public Web Push key browsers need to subscribe (D-21). Null when push is not configured. */
@Controller('v1/push')
export class PushConfigController {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  @Get('config')
  @ResponseSchema(pushConfigResponseSchema)
  config() {
    return { vapidPublicKey: this.env.VAPID_PUBLIC_KEY ?? null };
  }
}
