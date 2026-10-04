import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service.js';
import { RedisService } from './redis.service.js';

@Global()
@Module({
  providers: [RedisService, RateLimitService],
  exports: [RedisService, RateLimitService],
})
export class RedisModule {}
