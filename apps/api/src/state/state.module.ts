import { Global, Module } from '@nestjs/common';
import { EphemeralStore } from './ephemeral.store.js';
import { RateLimitService } from './rate-limit.service.js';

/** Short-lived shared state and rate limits, in Postgres (D-36). */
@Global()
@Module({
  providers: [EphemeralStore, RateLimitService],
  exports: [EphemeralStore, RateLimitService],
})
export class StateModule {}
