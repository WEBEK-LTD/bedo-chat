import { Controller, Get, Inject } from '@nestjs/common';
import { pushConfigResponseSchema } from '@bedo/contracts';
import { ResponseSchema } from '../common/response-schema.js';
import { PushSender } from '../delivery/push.service.js';

/** The public Web Push key browsers need to subscribe (D-21; made automatically since Phase 13, D-46). */
@Controller('v1/push')
export class PushConfigController {
  constructor(@Inject(PushSender) private readonly sender: PushSender) {}

  @Get('config')
  @ResponseSchema(pushConfigResponseSchema)
  async config() {
    return { vapidPublicKey: await this.sender.publicKey() };
  }
}
