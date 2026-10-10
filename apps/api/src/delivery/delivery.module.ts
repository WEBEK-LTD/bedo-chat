import { Global, Module } from '@nestjs/common';
import { OtpDeliveryService } from './otp-delivery.service.js';
import { PushSender, PushService, WebPushSender } from './push.service.js';
import { WaabekClient, WaabekSender } from './waabek.client.js';
import { WaabekKeyProvider } from './waabek-key.provider.js';

/** WhatsApp (Waabek) and Web Push delivery, inside the API (D-36). */
@Global()
@Module({
  providers: [
    { provide: WaabekSender, useClass: WaabekClient },
    WaabekKeyProvider,
    OtpDeliveryService,
    { provide: PushSender, useClass: WebPushSender },
    PushService,
  ],
  exports: [OtpDeliveryService, PushService, WaabekKeyProvider, WaabekSender, PushSender],
})
export class DeliveryModule {}
